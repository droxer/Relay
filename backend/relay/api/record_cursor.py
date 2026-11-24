"""Cursor for record lists ordered by update time and UUID."""

import base64
import binascii
import json
from datetime import datetime
from uuid import UUID

from fastapi import HTTPException


def encode_record_cursor(position: tuple[datetime, str]) -> str:
    """An opaque token for where the next page starts."""
    updated_at, record_id = position
    raw = json.dumps({"u": updated_at.isoformat(), "i": record_id}, separators=(",", ":"))
    return base64.urlsafe_b64encode(raw.encode()).decode().rstrip("=")


def decode_record_cursor(cursor: str) -> tuple[datetime, str]:
    try:
        padded = cursor + "=" * (-len(cursor) % 4)
        payload = json.loads(base64.urlsafe_b64decode(padded.encode()))
        updated_at = datetime.fromisoformat(payload["u"])
        record_id = str(UUID(payload["i"]))
    except (ValueError, TypeError, KeyError, binascii.Error) as error:
        raise HTTPException(400, "cursor is not valid.") from error
    return updated_at, record_id
