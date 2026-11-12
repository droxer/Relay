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
        elif action in ("remove", "edit", "promote"):
            if state.get("sending") == message_id:
                raise ValueError("This message is being sent. Wait for it to finish.")
            picked = next((m for m in messages if m["id"] == message_id), None)
            if not picked:
                if action == "edit":
                    raise ValueError("This message was already changed on another device.")
                return state
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
