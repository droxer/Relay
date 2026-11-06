"""Coordinate provider side effects without holding mutable document transactions.

PostgreSQL transaction advisory locks work across replicas and transaction
poolers. An asynchronous provider operation owns a separate, non-writing
connection so its secret changes can commit before the provider sends a webhook.
SQLite is the single-process development backend; its guard spans app contexts
and event loops in that process, while its transactions serialize document writes.
"""

from __future__ import annotations

import hashlib
from collections.abc import AsyncIterator, Iterator
from contextlib import asynccontextmanager, contextmanager
from pathlib import Path
from threading import Lock
from typing import Any

import psycopg
from sqlalchemy import text

from ..engine import store_transaction


class ChatOperationInProgress(ValueError):
    def __init__(self) -> None:
        super().__init__("A chat integration operation is already in progress. Retry after it finishes.")


_LOCAL_LOCK = Lock()
_LOCAL_OPERATIONS: set[tuple[str, str]] = set()


def _operation_key(integration_id: str) -> int:
    return int.from_bytes(hashlib.sha256(f"chat-provider:{integration_id}".encode()).digest()[:8], "big", signed=True)


@contextmanager
def _local_operation(engine: Any, integration_id: str) -> Iterator[None]:
    database = engine.url.database
    identity = str(Path(database).resolve()) if database and database != ":memory:" else f"memory:{id(engine)}"
    key = (identity, integration_id)
    with _LOCAL_LOCK:
        if key in _LOCAL_OPERATIONS:
            raise ChatOperationInProgress()
        _LOCAL_OPERATIONS.add(key)
    try:
        yield
    finally:
        with _LOCAL_LOCK:
            _LOCAL_OPERATIONS.remove(key)


@contextmanager
def chat_operation(engine: Any, integration_id: str) -> Iterator[None]:
    """Fence synchronous configuration changes against provider operations.

    The mutation enlists in this transaction, retaining one pool connection.
    A conflicting operation fails immediately instead of pinning a worker.
    """
    if engine.dialect.name != "postgresql":
        with _local_operation(engine, integration_id):
            yield
        return
    with store_transaction(engine) as conn:
        acquired = conn.scalar(text("SELECT pg_try_advisory_xact_lock(:key)"), {"key": _operation_key(integration_id)})
        if not acquired:
            raise ChatOperationInProgress()
        yield


@asynccontextmanager
async def provider_operation(engine: Any, integration_id: str) -> AsyncIterator[None]:
    """Keep one provider operation exclusive through success, error or cancellation."""
    if engine.dialect.name != "postgresql":
        with _local_operation(engine, integration_id):
            yield
        return
    # Reuse the dialect's decoded connection parameters. SQLAlchemy URL query
    # spaces render as '+', which libpq URI parsing treats as a literal plus.
    args, options = engine.dialect.create_connect_args(engine.url)
    # This dedicated connection owns only a coordination transaction. Never
    # enlist document writes in it: the provider may send the new secret before
    # its provisioning response returns. AsyncConnection closes on cancellation
    # and PostgreSQL releases the advisory lock when the connection disappears.
    async with await psycopg.AsyncConnection.connect(*args, **{**options, "connect_timeout": 5}) as conn:
        # A guard must not expire halfway through an external side effect.
        # Normal document transactions retain the engine's timeout guards.
        await conn.execute("SET LOCAL idle_in_transaction_session_timeout = 0")
        cursor = await conn.execute("SELECT pg_try_advisory_xact_lock(%s)", (_operation_key(integration_id),))
        acquired = await cursor.fetchone()
        if not acquired or not acquired[0]:
            raise ChatOperationInProgress()
        yield
