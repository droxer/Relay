"""Settle threads an older flow opened and never dispatched.

Each one reads ``running`` with nothing behind it, so every count of running
work included it. Idempotent: a settled thread is no longer open, and a thread
holding a run reservation is never touched — releasing one needs daemon exit
evidence or a person, never a boot repair.
"""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Any

from loguru import logger

from ..sessions.abandoned import ABANDONED_AFTER, is_never_dispatched, never_dispatched_settle_event


def settle_never_dispatched_sessions(
    *, session_store: Any, daemon_store: Any, now: datetime | None = None
) -> list[str]:
    """Settle each abandoned thread through its own log; return their ids."""
    cutoff = (now or datetime.now(UTC)) - ABANDONED_AFTER
    candidates = [
        session for session in session_store.list_open_sessions_idle_since(cutoff)
        if session.get("id") and is_never_dispatched(session)
    ]
    if not candidates:
        return []
    ids = {session["id"] for session in candidates}
    held = {request["sessionId"] for request in daemon_store.list_active_run_requests(session_ids=ids)}
    held |= {run["sessionId"] for run in daemon_store.list_active_runs(session_ids=ids)}
    settled = []
    for session in candidates:
        if session["id"] in held:
            continue
        session_store.append_event(session["id"], never_dispatched_settle_event(session["id"]), hydrate_events=False)
        settled.append(session["id"])
    return settled


def settle_abandoned_sessions_at_startup(*, session_store: Any, daemon_store: Any) -> None:
    """Deferred, never fatal: a stale status misleads counts but blocks nothing."""
    try:
        settled = settle_never_dispatched_sessions(session_store=session_store, daemon_store=daemon_store)
        if settled:
            logger.info("Settled threads that were never dispatched", count=len(settled), session_ids=settled)
    except Exception:  # noqa: BLE001 - a stale thread status must not stop the backend serving
        logger.exception("Settling never-dispatched threads deferred")
