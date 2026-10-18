from __future__ import annotations

import random
import string
import time
import uuid
from datetime import datetime, UTC


def now_iso() -> str:
    return datetime.now(UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _base36(value: int) -> str:
    alphabet = "0123456789abcdefghijklmnopqrstuvwxyz"
    if value == 0:
        return "0"
    result = ""
    while value:
        value, rem = divmod(value, 36)
        result = alphabet[rem] + result
    return result


def new_relay_id(prefix: str) -> str:
    suffix = "".join(random.choice(string.ascii_lowercase + string.digits) for _ in range(6))
    return f"{prefix}_{_base36(int(time.time() * 1000))}_{suffix}"


def new_database_id() -> str:
    return str(uuid.uuid4())


def new_sandbox_id() -> str:
    """Return the canonical identifier for a daemon node."""
    return str(uuid.uuid4())
