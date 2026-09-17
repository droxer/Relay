"""Transactional cross-replica locks for low-frequency resource mutations."""

from contextlib import contextmanager
import hashlib
from typing import Any, Iterator

from sqlalchemy import text
from .store_common import store_transaction


@contextmanager
def resource_transaction(engine: Any, key: str) -> Iterator[Any]:
    with store_transaction(engine) as conn:
        sqlite_owner = engine.dialect.name == "sqlite" and not conn.info.get(
            "relay_resource_lock"
        )
        if sqlite_owner:
            # Acquire SQLite's writer reservation before reading mutable state.
            if not conn.connection.driver_connection.in_transaction:
                conn.exec_driver_sql("BEGIN IMMEDIATE")
            conn.info["relay_resource_lock"] = True
        elif engine.dialect.name == "postgresql":
            lock_id = int.from_bytes(
                hashlib.sha256(key.encode()).digest()[:8], "big", signed=True
            )
            conn.execute(text("SELECT pg_advisory_xact_lock(:key)"), {"key": lock_id})
        try:
            yield conn
        finally:
            if sqlite_owner:
                conn.info.pop("relay_resource_lock", None)
