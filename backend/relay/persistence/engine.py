"""Database engines, store transactions, and the after-commit hook every store shares."""

from __future__ import annotations

import os
from collections.abc import Callable
from contextlib import contextmanager
from threading import RLock, local
from typing import Any

from sqlalchemy import create_engine, text
from sqlalchemy import event as sa_event
from sqlalchemy.engine import make_url

from . import schema

_ENGINES: dict[str, Any] = {}
_ENGINE_LOCK = RLock()


def _positive_env_number(name: str, default: str, cast: Any) -> Any:
    raw = os.environ.get(name, default).strip()
    try:
        value = cast(raw)
    except ValueError as error:
        raise ValueError(f"{name} must be a positive number.") from error
    if value <= 0:
        raise ValueError(f"{name} must be a positive number.")
    return value


def _non_negative_env_int(name: str, default: str) -> int:
    raw = os.environ.get(name, default).strip()
    try:
        value = int(raw)
    except ValueError as error:
        raise ValueError(f"{name} must be a non-negative integer.") from error
    if value < 0:
        raise ValueError(f"{name} must be a non-negative integer.")
    return value


def _session_timeout_options(url: Any) -> str:
    """Server-side guards so one stuck request cannot pin a connection or lock.

    Applied to the application engine only; Alembic builds its own engine, so a
    long backfill is never cut off. 0 disables a guard. Any ``options`` already
    in the URL (a test's search_path, say) is kept, because psycopg's
    ``connect_args`` would otherwise replace it.
    """
    guards = [
        ("statement_timeout", "RELAY_DB_STATEMENT_TIMEOUT_MS", "30000"),
        (
            "idle_in_transaction_session_timeout",
            "RELAY_DB_IDLE_IN_TRANSACTION_TIMEOUT_MS",
            "60000",
        ),
    ]
    parts = [str(url.query["options"])] if url.query.get("options") else []
    for setting, env_name, default in guards:
        value = _non_negative_env_int(env_name, default)
        if value:
            parts.append(f"-c {setting}={value}")
    return " ".join(parts)


def database_engine_options(database_url: str) -> dict[str, Any]:
    """Build bounded per-replica pool settings for server databases."""
    url = make_url(database_url)
    if url.get_backend_name() == "sqlite":
        return {}
    # Check pooled connections before use: recycling only handles their age,
    # not database restarts or proxy disconnects. A failed transaction is not
    # automatically replayed. Keep the pool sized for the worker threadpool.
    pre_ping = os.environ.get("RELAY_DB_POOL_PRE_PING", "true").strip().lower()
    if pre_ping not in {"1", "true", "yes", "on", "0", "false", "no", "off"}:
        raise ValueError("RELAY_DB_POOL_PRE_PING must be a boolean.")
    options: dict[str, Any] = {
        "pool_size": _positive_env_number("RELAY_DB_POOL_SIZE", "20", int),
        "max_overflow": _positive_env_number("RELAY_DB_MAX_OVERFLOW", "20", int),
        "pool_timeout": _positive_env_number(
            "RELAY_DB_POOL_TIMEOUT_SECONDS", "5", float
        ),
        "pool_recycle": _positive_env_number(
            "RELAY_DB_POOL_RECYCLE_SECONDS", "300", int
        ),
        "pool_pre_ping": pre_ping in {"1", "true", "yes", "on"},
        "pool_use_lifo": True,
    }
    timeouts = _session_timeout_options(url)
    if timeouts:
        options["connect_args"] = {"options": timeouts}
    return options


def shared_engine(database_url: str) -> Any:
    """One Engine per database URL, shared by every store.

    Stores used to build an Engine each, so eight connection pools pointed at
    the same database and no operation could span two stores in one
    transaction. Sharing the Engine is what lets `transaction()` make a
    multi-store write -- deleting a user, say -- atomic.
    """
    with _ENGINE_LOCK:
        engine = _ENGINES.get(database_url)
        if engine is None:
            engine = create_engine(
                database_url, future=True, **database_engine_options(database_url)
            )
            if engine.dialect.name == "sqlite":
                _serialize_sqlite_writers(engine)
            _ENGINES[database_url] = engine
        return engine


SQLITE_BUSY_TIMEOUT_MS = 30_000
# WAL lets readers proceed while a writer holds the lock, and NORMAL sync
# under WAL still survives a process crash (only an OS crash can lose the
# last transactions), which is the right trade for a local-first dev store.
# A memory database ignores the journal mode, so both are safe everywhere.
SQLITE_CONNECT_PRAGMAS = ("PRAGMA journal_mode = WAL", "PRAGMA synchronous = NORMAL")


def _serialize_sqlite_writers(engine: Any) -> None:
    """Begin every SQLite transaction with ``BEGIN IMMEDIATE``.

    Stores serialize a read-then-write (the next event sequence, a claim) with
    ``SELECT ... FOR UPDATE``, which SQLite ignores, and pysqlite's deferred
    transactions let two writers read the same row before either writes. Taking
    the write lock at ``BEGIN`` gives SQLite the serialization the row lock
    gives Postgres; ``busy_timeout`` makes a contender wait instead of failing.
    """

    @sa_event.listens_for(engine, "connect")
    def _connect(dbapi_connection: Any, _record: Any) -> None:
        dbapi_connection.isolation_level = None  # let SQLAlchemy emit BEGIN
        dbapi_connection.execute(f"PRAGMA busy_timeout = {SQLITE_BUSY_TIMEOUT_MS}")
        for pragma in SQLITE_CONNECT_PRAGMAS:
            dbapi_connection.execute(pragma)

    @sa_event.listens_for(engine, "begin")
    def _begin(connection: Any) -> None:
        connection.exec_driver_sql("BEGIN IMMEDIATE")


def publish_database_notification(
    conn: Any, engine: Any, channel: str | None, payload: str
) -> None:
    """Publish a transactional PostgreSQL wakeup when notifications are enabled."""
    if channel and engine.dialect.name == "postgresql":
        conn.execute(
            text("SELECT pg_notify(:channel, :payload)"),
            {"channel": channel, "payload": payload},
        )


def create_all_tables(engine: Any) -> None:
    """Create every Relay table on `engine`.

    Always creates the whole schema, never one store's slice: foreign keys now
    cross store boundaries, so `agents` cannot be created without `users`
    also being registered on the shared MetaData.
    """
    schema.metadata.create_all(engine)


_TRANSACTION_STATE = local()


@contextmanager
def store_transaction(engine: Any) -> Any:
    """Open a transaction on `engine`, or join the enclosing one.

    Every store method opens one of these instead of `engine.begin()`. On its
    own it behaves identically. Wrapped in an outer `store_transaction` on the
    same engine, the inner ones enlist in it rather than committing separately,
    which is what makes a cascade that spans stores -- deleting a user and
    its agents, placements, teams, and nodes -- atomic.

    The bookkeeping is thread-local, so a transaction on one thread never leaks
    into a store call on another.
    """
    connections = getattr(_TRANSACTION_STATE, "connections", None)
    if connections is None:
        connections = {}
        _TRANSACTION_STATE.connections = connections

    key = id(engine)
    joined = connections.get(key)
    if joined is not None:
        yield joined
        return

    pending = getattr(_TRANSACTION_STATE, "after_commit", None)
    if pending is None:
        pending = {}
        _TRANSACTION_STATE.after_commit = pending
    callbacks: list[Callable[[], None]] = []
    with engine.begin() as connection:
        connections[key] = connection
        pending[key] = callbacks
        try:
            yield connection
        finally:
            connections.pop(key, None)
            pending.pop(key, None)
    # Reached only after the outer transaction committed successfully. Cleanup
    # runs outside its connection scope, so it cannot participate in a rollback.
    for callback in callbacks:
        callback()


def after_store_commit(engine: Any, callback: Callable[[], None]) -> None:
    """Defer a side effect to the enclosing store commit, or run it immediately."""
    callbacks = getattr(_TRANSACTION_STATE, "after_commit", {}).get(id(engine))
    if callbacks is None:
        callback()
    else:
        callbacks.append(callback)
