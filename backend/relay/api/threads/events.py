from __future__ import annotations

import json
import time
from collections.abc import AsyncIterator
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any

from fastapi import APIRouter, Request
from fastapi.responses import StreamingResponse
from starlette.concurrency import run_in_threadpool

from ...core.settings import StreamSettings
from ...realtime.event_notifier import session_event_key
from ..actors import (
    get_session_header_for_actor,
    request_actor_or_sandbox,
)
from ..deps import AppContext, AppContextDep

router = APIRouter()


# Session lifecycle states after which no further events are appended; the
# stream flushes the backlog and closes when it sees one of these.
TERMINAL_SESSION_STATUSES = frozenset({"completed", "failed", "cancelled"})
# Agent subprocesses emit output in small chunks, but this tail loop is the
# final hop before the browser; its knobs are validated in core/settings.py.
_STREAM_SETTINGS = StreamSettings.from_env()
_STREAM_FALLBACK_SECONDS = _STREAM_SETTINGS.fallback_seconds
_STREAM_EVENT_PAGE_LIMIT = _STREAM_SETTINGS.event_page_limit
_STREAM_HEARTBEAT_SECONDS = 15.0
_STREAM_MAX_SECONDS = _STREAM_SETTINGS.max_seconds


def _sse_frame(data: dict[str, Any], *, event: str | None = None) -> str:
    event_id = data.get("id")
    prefix = f"id: {event_id}\n" if isinstance(event_id, str) and event_id else ""
    prefix += f"event: {event}\n" if event else ""
    return f"{prefix}data: {json.dumps(data)}\n\n"


@dataclass
class _EventTail:
    """Where one SSE connection stands in a thread's event log."""

    after_event_id: str | None
    start: float
    last_heartbeat: float
    next_sequence: int | None = None


def _open_event_tail(request: Request) -> _EventTail:
    # EventSource keeps the original URL across automatic reconnects but
    # advances Last-Event-ID as frames arrive. Prefer that live cursor over
    # the URL's initial `after` value so a reconnect does not replay the
    # entire stream window.
    after_event_id = request.headers.get("last-event-id") or request.query_params.get("after")
    start = time.monotonic()
    return _EventTail(after_event_id=after_event_id, start=start, last_heartbeat=start)


async def _read_tail_page(
    ctx: AppContext, session_id: str, tail: _EventTail
) -> dict[str, Any] | None:
    """The next page after the tail's cursor, advancing it; None once the thread is gone."""
    try:
        page = await run_in_threadpool(
            ctx.session_store.read_event_page,
            session_id,
            after_event_id=tail.after_event_id if tail.next_sequence is None else None,
            after_sequence=tail.next_sequence,
            limit=_STREAM_EVENT_PAGE_LIMIT,
        )
    except KeyError:
        return None
    tail.next_sequence = page["nextSequence"]
    return page


def _finished_frame(page: dict[str, Any]) -> str | None:
    """The closing frame once a terminal thread's history is fully sent."""
    status = page.get("status")
    history_drained = page["nextSequence"] >= int(page.get("version") or 0)
    if status in TERMINAL_SESSION_STATUSES and history_drained:
        return _sse_frame({"status": status}, event="done")
    return None


def _timer_frames(tail: _EventTail, status: Any, now: float) -> tuple[list[str], bool]:
    """A due heartbeat, then the timeout close; True when the stream must end."""
    frames: list[str] = []
    if now - tail.last_heartbeat >= _STREAM_HEARTBEAT_SECONDS:
        timestamp = datetime.now(UTC).isoformat().replace("+00:00", "Z")
        frames.append(_sse_frame({"timestamp": timestamp}, event="heartbeat"))
        tail.last_heartbeat = now
    if now - tail.start >= _STREAM_MAX_SECONDS:
        frames.append(_sse_frame({"status": status, "reason": "timeout"}, event="done"))
        return frames, True
    return frames, False


def _tail_wait_seconds(tail: _EventTail, now: float) -> float:
    wait_seconds = min(
        _STREAM_FALLBACK_SECONDS,
        _STREAM_HEARTBEAT_SECONDS - (now - tail.last_heartbeat),
        _STREAM_MAX_SECONDS - (now - tail.start),
    )
    return max(0.001, wait_seconds)


@router.get("/threads/{session_id}/events")
async def session_events(
    session_id: str, request: Request, ctx: AppContextDep
) -> StreamingResponse:
    actor = await run_in_threadpool(request_actor_or_sandbox, request, ctx.auth_store, ctx.registry)
    # Authorize before the stream opens so 403/404 surface as normal responses.
    await run_in_threadpool(
        get_session_header_for_actor, ctx.session_store, session_id, actor
    )

    async def event_stream() -> AsyncIterator[str]:
        # Server-side tail-poll: read only newly appended rows from the event
        # log each tick. The web client coalesces that tick's message frames
        # into one render commit, while other SSE consumers keep the existing
        # one-domain-event-per-frame contract.
        tail = _open_event_tail(request)
        notification_key = session_event_key(session_id)
        notifier = ctx.control_plane_notifier
        while not await request.is_disconnected():
            with notifier.observe(notification_key) as observed_version:
                page = await _read_tail_page(ctx, session_id, tail)
                if page is None:
                    return
                events = page["events"]
                for event in events:
                    yield _sse_frame(event)
                if events:
                    tail.last_heartbeat = time.monotonic()
                finished = _finished_frame(page)
                if finished is not None:
                    yield finished
                    return
                now = time.monotonic()
                frames, timed_out = _timer_frames(tail, page.get("status"), now)
                for frame in frames:
                    yield frame
                if timed_out:
                    return
                if events:
                    continue
                await notifier.wait(
                    notification_key, observed_version, timeout=_tail_wait_seconds(tail, now)
                )

    return StreamingResponse(
        event_stream(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )
