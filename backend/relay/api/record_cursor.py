"""Cursor for record lists ordered by update time and UUID."""

import base64
import binascii
import json
from datetime import datetime
from uuid import UUID

from fastapi import HTTPException

from ..persistence.workspace import ThreadSummaryPosition


def encode_record_cursor(position: ThreadSummaryPosition) -> str:
    """An opaque token for where the next page starts."""
    payload = {"u": position[0].isoformat(), "i": position[1]}
    if len(position) == 3:
        raw = json.dumps({**payload, "p": position[2]}, separators=(",", ":"))
    else:
        raw = json.dumps(payload, separators=(",", ":"))
    return base64.urlsafe_b64encode(raw.encode()).decode().rstrip("=")


def decode_record_cursor(cursor: str) -> tuple[datetime, str]:
    updated_at, record_id, _pinned = _decode_cursor(cursor)
    return updated_at, record_id


def decode_thread_summary_cursor(cursor: str) -> ThreadSummaryPosition:
    updated_at, record_id, pinned = _decode_cursor(cursor)
    return (updated_at, record_id) if pinned is None else (updated_at, record_id, pinned)


def _decode_cursor(cursor: str) -> tuple[datetime, str, bool | None]:
    try:
        padded = cursor + "=" * (-len(cursor) % 4)
        payload = json.loads(base64.urlsafe_b64decode(padded.encode()))
        updated_at = datetime.fromisoformat(payload["u"])
        record_id = str(UUID(payload["i"]))
        pinned = payload.get("p")
        if pinned is not None and not isinstance(pinned, bool):
            raise ValueError("The pinned cursor key must be a boolean.")
    except (ValueError, TypeError, KeyError, binascii.Error) as error:
        raise HTTPException(400, "cursor is not valid.") from error
    return updated_at, record_id, pinned
