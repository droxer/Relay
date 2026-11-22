"""Durable thread follow-ups, dispatched through the ordinary round admission."""

from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator, Callable
from contextlib import asynccontextmanager
from copy import deepcopy
from datetime import UTC, datetime, timedelta
from typing import Any

from loguru import logger

from ..persistence.events import relay_event
from ..core.thread_queue import queue_can_continue
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


def _save_queue(store: Any, thread_id: str, state: dict[str, Any], receipt_id: str | None = None) -> None:
    event = relay_event("session.queue", thread_id, {"queue": state})
    if receipt_id:
        event["id"] = f"queue.accepted:{receipt_id}"
    store.append_event(thread_id, event, hydrate_events=False)


def _steering(state: dict[str, Any]) -> bool:
    return state.get("steeringUntil", "") > datetime.now(UTC).isoformat()


def live_pending(state: dict[str, Any]) -> bool:
    """A message was handed to the live run and its computer has not answered yet."""
    return (state.get("live") or {}).get("until", "") > datetime.now(UTC).isoformat()


def _promote(state: dict[str, Any], message_id: str) -> None:
    if state.get("sending") or _steering(state):
        raise ValueError("This message is being sent. Wait for it to finish.")
    messages = state["messages"]
    index = next((i for i, message in enumerate(messages) if message["id"] == message_id), None)
    if index is None:
        raise ValueError("This message was already changed on another device.")
    messages.insert(0, messages.pop(index))
    state.update(paused=False, sendRequested=True)
    state.pop("error", None)
    state.pop("steeringUntil", None)


def stop_and_send(
    store: Any, thread_id: str, message_id: str, cancel: Callable[[], Any],
) -> dict[str, Any]:
    # Commit a pause before asking the Computer to stop. If the old run exits
    # during cancellation, another dispatcher must still wait before sending.
    with store.mutation_scope(thread_id):
        session = store.get_session_header(thread_id)
        if session.get("deletionRequestedAt") or session.get("archived"):
            raise ValueError("This thread is archived or being deleted.")
        state = queue_state(session)
        _promote(state, message_id)
        lease = (datetime.now(UTC) + timedelta(minutes=5)).isoformat()
        state.update(paused=True, steeringUntil=lease)
        _save_queue(store, thread_id, state)
    stopped = False
    try:
        cancel()
        stopped = True
    finally:
        with store.mutation_scope(thread_id):
            state = queue_state(store.get_session_header(thread_id))
            if state.get("steeringUntil") == lease:
                state.pop("steeringUntil")
                if stopped and state.get("sendRequested"):
                    _promote(state, message_id)
                else:
                    state.pop("sendRequested", None)
                _save_queue(store, thread_id, state)
    return state


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
                state.pop("sendRequested", None)
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
        elif action == "promote":
            _promote(state, message_id)
        elif action in ("remove", "edit"):
            if state.get("sending") == message_id or _steering(state):
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
        elif action in ("pause", "resume"):
            if action == "resume" and _steering(state):
                raise ValueError("This message is being sent. Wait for it to finish.")
            state["paused"] = action == "pause"
            state.pop("error", None)
            if action == "pause" or state.pop("steeringUntil", None):
                state.pop("sendRequested", None)
        else:
            raise ValueError("Unknown queue action.")
        _save_queue(store, thread_id, state, message["id"] if message is not None else None)
        return state


class ThreadQueueDispatcher:
    def __init__(self, ctx: Any):
        self.ctx = ctx
        self._cursor: str | None = None
        self._wake: Callable[[str], None] | None = None

    def wake(self, thread_id: str) -> None:
        wake = self._wake
        if wake is not None:
            wake(thread_id)

    @asynccontextmanager
    async def wakeups(self) -> AsyncIterator[None]:
        loop = asyncio.get_running_loop()
        ready = asyncio.Event()
        pending: dict[str, None] = {}
        stopping = False

        def enqueue(thread_id: str) -> None:
            # Hints are coalesced and bounded. The periodic sweep covers overflow.
            if not stopping and len(pending) < 100:
                pending[thread_id] = None
                ready.set()

        def schedule(thread_id: str) -> None:
            loop.call_soon_threadsafe(enqueue, thread_id)

        async def drain() -> None:
            while not stopping:
                await ready.wait()
                ready.clear()
                while pending and not stopping:
                    thread_id = next(iter(pending))
                    pending.pop(thread_id)
                    await self._dispatch_safely(thread_id)

        self._wake = schedule
        worker = asyncio.create_task(drain(), name="relay-thread-queue")
        try:
            yield
        finally:
            self._wake = None
            stopping = True
            ready.set()
            # Let an in-flight claim finish before closing its stores.
            await worker

    async def tick(self) -> None:
        candidates = await asyncio.to_thread(self.ctx.session_store.queued_thread_ids, after=self._cursor)
        for thread_id in candidates:
            self._cursor = thread_id
            await self._dispatch_safely(thread_id)
        if len(candidates) < 100:
            self._cursor = None

    async def _dispatch_safely(self, thread_id: str) -> None:
        try:
            await self.dispatch(thread_id)
        except Exception:  # noqa: BLE001 - isolate one damaged thread from the scheduler
            logger.exception("Thread queue dispatch failed", thread_id=thread_id)

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
            if live_pending(state):
                # Handed to the live run; its computer's answer decides what happens next.
                return None
            if state.get("sending"):
                if state["leaseUntil"] > datetime.now(UTC).isoformat():
                    return None
                # Retry the SAME durable intent after an interrupted dispatch.
                message = next(m for m in state["messages"] if m["id"] == state["sending"])
            else:
                if self.ctx.execution_lifecycle.status(session)["phase"] != "terminal":
                    return None
                if not queue_can_continue(session):
                    return None
                message = state["messages"][0]
            if (state.get("live") or {}).get("id") == message["id"]:
                # Its computer never answered: send it after the run instead.
                state.pop("live")
                state.pop("steeringUntil", None)
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
