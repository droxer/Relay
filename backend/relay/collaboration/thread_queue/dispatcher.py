"""Dispatch durable Thread follow-ups through ordinary round admission."""

from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator, Callable
from contextlib import asynccontextmanager
from datetime import UTC, datetime, timedelta
from typing import Any

from loguru import logger

from ...core.thread_queue import queue_can_continue
from ..errors import CollaborationError
from ..models import MessageIntent
from ..queue import _save_queue, live_pending, queue_state
from ..service import CollaborationConductor


# Follow a promoted message from the request that promoted it. The periodic
# sweep also covers a follow-up when its request's follower stops waiting.
STEER_FOLLOW_SECONDS = 180.0
STEER_POLL_SECONDS = 1.0
_followers: dict[str, asyncio.Task[None]] = {}


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
            _save_queue(store, thread_id, state)
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
            error = exc
        paused = await asyncio.to_thread(self._finish, thread_id, message["id"], error)
        # Stop can arrive after our claim but before admission creates a run
        # for the cancellation route to find. Close that gap after admission.
        accepted_request = dispatched.get("messageRunRequestId")
        if paused and not error and dispatched.get("daemonNodeId") and accepted_request:
            await asyncio.to_thread(
                self.ctx.backend.cancel_run,
                dispatched["daemonNodeId"],
                thread_id,
                "Queue paused during dispatch.",
                actor_user_id=claim["owner"],
                expected_run_request_id=accepted_request,
            )

    def _finish(self, thread_id: str, message_id: str, error: CollaborationError | None) -> bool:
        store = self.ctx.session_store
        with store.mutation_scope(thread_id):
            state = queue_state(store.get_session_header(thread_id))
            if state.get("sending") != message_id:
                return False
            state.pop("sending", None)
            state.pop("leaseUntil", None)
            # Another round can acquire the Thread after the queue's claim.
            # Keep the original message (and any explicit send) for the next exit.
            if error is None or error.code != "thread_run_active":
                state.pop("sendRequested", None)
                if error is not None:
                    state.update(paused=True, error=str(error))
                else:
                    state["messages"] = [m for m in state["messages"] if m["id"] != message_id]
                    state.pop("error", None)
            _save_queue(store, thread_id, state)
            return bool(state["paused"])
