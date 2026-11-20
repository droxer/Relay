"""Compact snapshots for browser transcript hydration and reconciliation."""

from __future__ import annotations

import re
from hashlib import sha256
from typing import Any

from fastapi import HTTPException, Request, Response
from starlette.responses import JSONResponse

from ..conditional_get import etag_matches, weak_etag
from ...persistence.protocols import SessionStore

_WINDOW_LIMIT = 160
_WINDOW_BYTES = 384 * 1024
_COMPACT_WINDOW_BYTES = 128 * 1024
_KNOWN_EVENTS = re.compile(r"([0-9]{1,10}):([0-9]{1,10}):([0-9a-f]{64})")


def read_transcript_page(
    store: SessionStore, header: dict[str, Any], before: str | None, *, compact: bool = False,
) -> dict[str, Any]:
    end = int(header["eventCount"])
    if before is not None:
        if not re.fullmatch(r"[0-9]{1,10}", before) or not 0 < int(before) <= end:
            raise HTTPException(400, "Invalid transcript page boundary.")
        end = int(before)
    start, events = store.read_transcript_page(
        header["id"], before=end, limit=_WINDOW_LIMIT,
        max_bytes=_COMPACT_WINDOW_BYTES if compact and before is None else _WINDOW_BYTES,
    )
    return {"eventStart": start, "eventCount": end, "events": events}


def _events_revision(events: list[dict[str, Any]]) -> str:
    return sha256(JSONResponse(events).body).hexdigest()


def transcript_response(request: Request, session: dict[str, Any], *, compact: bool = False) -> Response:
    events = session["events"]
    start = session["eventStart"]
    revision = _events_revision(events)
    snapshot = {
        **{key: value for key, value in session.items() if key != "events"},
        "eventsRevision": revision,
    }
    if compact:
        # Run briefs are execution inputs. The transcript renders the events
        # and uses these run and assignment records for identity and status.
        snapshot["agentRuns"] = [
            {key: value for key, value in run.items() if key not in {"brief", "workspaceIdentity"}}
            for run in session.get("agentRuns", [])
        ]
        snapshot["collaborationRounds"] = [
            {**round_, "assignments": [
                {key: value for key, value in assignment.items() if key != "brief"}
                for assignment in round_.get("assignments", [])
            ]}
            for round_ in session.get("collaborationRounds", [])
        ]
    etag = weak_etag(bytes(JSONResponse(snapshot).body))
    headers = {"ETag": etag.decode("ascii"), "Cache-Control": "no-store"}
    if etag_matches(request.headers.get("if-none-match", "").encode("latin-1"), etag):
        return Response(status_code=304, headers=headers)

    offset = 0
    known = _KNOWN_EVENTS.fullmatch(request.headers.get("x-relay-thread-events", ""))
    if known:
        known_start, count, expected_revision = int(known[1]), int(known[2]), known[3]
        if start == known_start and 0 < count <= len(events):
            prefix_revision = revision if count == len(events) else _events_revision(events[:count])
            if prefix_revision == expected_revision:
                offset = count
    return JSONResponse({**snapshot, "eventOffset": start + offset, "events": events[offset:]}, headers=headers)
