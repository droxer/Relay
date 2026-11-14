"""Durable thread follow-ups, dispatched through the ordinary round admission."""

from __future__ import annotations

import asyncio
from copy import deepcopy
from datetime import UTC, datetime, timedelta
from typing import Any

from loguru import logger

from ..persistence.events import relay_event
from .errors import CollaborationError
from .models import MessageIntent
from .service import CollaborationConductor


# A steered message is followed from the request that promoted it, so it goes
# out as soon as the stopped run settles instead of on the next scheduler
# sweep. The sweep still covers anything a follower gives up on.
STEER_FOLLOW_SECONDS = 180.0
STEER_POLL_SECONDS = 1.0
_followers: dict[str, asyncio.Task[None]] = {}


def queue_state(session: dict[str, Any]) -> dict[str, Any]:
    return deepcopy(session.get("messageQueue") or {"messages": [], "paused": False})


def change_queue(
    store: Any, thread_id: str, action: str, *, message: dict[str, Any] | None = None, message_id: str = ""
) -> dict[str, Any]:
    with store.mutation_scope(thread_id):
        session = store.get_session_header(thread_id)
        if action != "pause" and (session.get("deletionRequestedAt") or session.get("archived")):
            raise ValueError("This thread is archived or being deleted.")
        state = queue_state(session)
        messages = state["messages"]
        if action in ("enqueue", "import"):
            assert message is not None
            receipt = store.queue_receipt(thread_id, message["id"])
            original = (receipt or {}).get("queue", {}).get("messages", [])
            existing = next((m for m in [*messages, *original] if m["id"] == message["id"]), None)
            if existing:
                if existing != message:
                    raise ValueError("This message ID already names another message.")
                return state
            if len(messages) >= 20:
                raise ValueError("The queue is full (20 messages).")
            messages.append(message)
            if action == "import":
                state["paused"] = True
        elif action == "undo_remove":
            removed = state.get("removed")
            if not removed or removed["message"]["id"] != message_id:
                return state
            if len(messages) >= 20:
                raise ValueError("The queue is full (20 messages).")
            if not any(item["id"] == message_id for item in messages):
                index = next((i for i, item in enumerate(messages) if item["id"] == removed.get("beforeId")), len(messages))
                messages.insert(index, removed["message"])
            state.pop("removed", None)
        elif action in ("remove", "edit", "promote"):
            if state.get("sending") == message_id:
                raise ValueError("This message is being sent. Wait for it to finish.")
            picked = next((m for m in messages if m["id"] == message_id), None)
            if not picked:
                if action == "edit":
                    raise ValueError("This message was already changed on another device.")
                return state
            if action == "remove":
                index = messages.index(picked)
                state["removed"] = {"message": picked, "beforeId": messages[index + 1]["id"] if index + 1 < len(messages) else None,
                                    "removedAt": datetime.now(UTC).isoformat()}
            state["messages"] = [m for m in messages if m["id"] != message_id]
            if action == "promote":
                state["messages"].insert(0, picked)
                state["paused"] = False
                state["sendRequested"] = True
                state.pop("error", None)
        elif action in ("pause", "resume"):
            state["paused"] = action == "pause"
            state.pop("error", None)
        else:
            raise ValueError("Unknown queue action.")
        event = relay_event("session.queue", thread_id, {"queue": state})
        if action in ("enqueue", "import"):
            event["id"] = f"queue.accepted:{message['id']}"  # type: ignore[index]
        store.append_event(thread_id, event, hydrate_events=False)
        return state


class ThreadQueueDispatcher:
    def __init__(self, ctx: Any):
        self.ctx = ctx
        self._cursor: str | None = None

    async def tick(self) -> None:
        candidates = await asyncio.to_thread(self.ctx.session_store.queued_thread_ids, after=self._cursor)
        if not candidates:
            self._cursor = None
            return
        for thread_id in candidates:
            self._cursor = thread_id
            try:
                await self.dispatch(thread_id)
            except Exception:  # noqa: BLE001 - isolate one damaged thread from the scheduler
                logger.exception("Thread queue dispatch failed", thread_id=thread_id)
        if len(candidates) < 100:
            self._cursor = None

    def follow_requested_send(self, thread_id: str) -> None:
        """Start (once per thread in this process) following a steered message."""
        if thread_id in _followers:
            return
        task = asyncio.create_task(self._follow(thread_id), name=f"relay-steer-{thread_id}")
        _followers[thread_id] = task
        task.add_done_callback(lambda _task: _followers.pop(thread_id, None))

    async def _follow(self, thread_id: str) -> None:
        loop = asyncio.get_running_loop()
        deadline = loop.time() + STEER_FOLLOW_SECONDS
        try:
            while loop.time() < deadline:
                pending = await asyncio.to_thread(self._requested_send, thread_id)
                if pending is None:
                    return  # Sent, withdrawn, paused, or another dispatcher holds it.
                if pending:
                    await self.dispatch(thread_id)
                await asyncio.sleep(STEER_POLL_SECONDS)
        except Exception:  # noqa: BLE001 - the scheduler sweep remains the fallback
            logger.exception("Steered message follow-up failed", thread_id=thread_id)

    def _requested_send(self, thread_id: str) -> bool | None:
        """None once there is nothing left to follow; otherwise whether the
        thread is free, read without the mutation lock the claim takes."""
        session = self.ctx.session_store.get_session_header(thread_id)
        state = queue_state(session)
        if (not state["messages"] or state["paused"] or not state.get("sendRequested")
                or state.get("sending")):
            return None
        return self.ctx.execution_lifecycle.status(session)["phase"] == "terminal"

    def _claim(self, thread_id: str) -> dict[str, Any] | None:
        store = self.ctx.session_store
        with store.mutation_scope(thread_id):
            session = store.get_session_header(thread_id)
            state = queue_state(session)
            if (
                not state["messages"]
                or state["paused"]
                or session.get("archived")
                or session.get("deletionRequestedAt")
            ):
                return None
            if state.get("sending"):
                if state["leaseUntil"] > datetime.now(UTC).isoformat():
                    return None
                # Retry the SAME durable intent after an interrupted dispatch.
                message = next(m for m in state["messages"] if m["id"] == state["sending"])
            else:
                if self.ctx.execution_lifecycle.status(session)["phase"] != "terminal":
                    return None
                if not state.get("sendRequested") and (
                    session.get("pendingDecision")
                    or session.get("inputQuestion")
                    or session.get("permissionRequests")
                    or session.get("status") == "waiting_for_human"
                    or session.get("workOutcome") == "blocked"
                ):
                    return None
                message = state["messages"][0]
            state["sending"] = message["id"]
            state["leaseUntil"] = (datetime.now(UTC) + timedelta(minutes=5)).isoformat()
            store.append_event(
                thread_id, relay_event("session.queue", thread_id, {"queue": state}), hydrate_events=False
            )
            return {"message": message, "owner": session["ownerUserId"]}

    async def dispatch(self, thread_id: str) -> None:
        claim = await asyncio.to_thread(self._claim, thread_id)
        if not claim:
            return
        message = claim["message"]
        error = None
        dispatched: dict[str, Any] = {}
        try:
            dispatched = await CollaborationConductor(self.ctx).submit(
                MessageIntent(
                    thread_id=thread_id,
                    text=message["text"],
                    address_agent_ids=tuple(message.get("addressAgentIds", [])),
                    address_team_id=message.get("addressTeamId"),
                    idempotency_key=f"queue:{message['id']}",
                    user_message_id=f"evt_{message['id']}",
                ),
                {"userId": claim["owner"], "isAdmin": False},
            )
        except CollaborationError as exc:
            error = str(exc)
        paused = await asyncio.to_thread(self._finish, thread_id, message["id"], error)
        # Stop can arrive after our claim but before admission creates a run
        # for the cancellation route to find. Close that gap after admission.
        if paused and not error and dispatched.get("daemonNodeId"):
            await asyncio.to_thread(
                self.ctx.backend.cancel_run,
                dispatched["daemonNodeId"],
                thread_id,
                "Queue paused during dispatch.",
                actor_user_id=claim["owner"],
            )

    def _finish(self, thread_id: str, message_id: str, error: str | None) -> bool:
        store = self.ctx.session_store
        with store.mutation_scope(thread_id):
            state = queue_state(store.get_session_header(thread_id))
            if state.get("sending") != message_id:
                return False
            state.pop("sending", None)
            state.pop("leaseUntil", None)
            state.pop("sendRequested", None)
            if error:
                state.update(paused=True, error=error)
            else:
                state["messages"] = [m for m in state["messages"] if m["id"] != message_id]
                state.pop("error", None)
            store.append_event(
                thread_id, relay_event("session.queue", thread_id, {"queue": state}), hydrate_events=False
            )
            return bool(state["paused"])
