from __future__ import annotations

from collections.abc import Callable, Iterator
from contextlib import contextmanager
from typing import Any

from sqlalchemy import (
    Index,
    inspect,
    select,
    text,
)

from .blob_store import BlobStore
from .store_common import (
    create_all_tables,
    shared_engine,
    store_transaction,
)
from .sql import metadata as shared_metadata
from .tables import sessions as sessions_tables
from .session.rows import (
    _canonical_database_session_id,
    _shared_affinity_lock,
    session_event_cursor_expression,
)
from .session.lifecycle import SessionLifecycleRows
from .session.events import SessionEventRows
from .session.deletion import SessionDeletionRows
from .session.artifacts import SessionArtifactRows
from .session.reads import SessionReadRows
from .listeners import ChangeListener



class DatabaseSessionStore(
    SessionLifecycleRows,
    SessionEventRows,
    SessionDeletionRows,
    SessionArtifactRows,
    SessionReadRows,
):
    REQUIRED_SCHEMA_REVISION = "20261010_0086"
    metadata = shared_metadata

    sessions = sessions_tables.sessions
    events = sessions_tables.events
    artifacts = sessions_tables.artifacts
    run_token_usage = sessions_tables.run_token_usage
    agent_runs = sessions_tables.agent_runs
    workspace_files = sessions_tables.workspace_files
    tombstones = sessions_tables.tombstones

    def __init__(
        self,
        database_url: str,
        *,
        create_schema: bool = False,
        blob_store: BlobStore | None = None,
    ):
        self.engine = shared_engine(database_url)
        # Where workspace-artifact snapshot bytes go; None keeps them inline.
        self.blob_store = blob_store
        # Only a running matcher drains the automation outbox; without one,
        # writing rows would grow the table forever. ``create_app`` turns this
        # off when the scheduler is disabled.
        self.emit_automation_events = True
        self._affinity_lock = _shared_affinity_lock(f"database:{self.engine.url}")
        self._event_changes = ChangeListener("Session event")
        if create_schema:
            create_all_tables(self.engine)

    def set_event_listener(
        self, listener: Callable[[str], None], *, database_channel: str | None = None
    ) -> None:
        self._event_changes.attach(listener, database_channel)

    def verify_schema(self) -> None:
        """Fail startup before serving traffic when session migrations are absent."""
        schema = inspect(self.engine)
        required_tables = {
            "sessions",
            "session_events",
            "session_artifacts",
            "session_run_token_usage",
            "session_agent_runs",
            "session_tombstones",
            "session_workspace_files",
        }
        missing = required_tables.difference(schema.get_table_names())
        if missing:
            raise RuntimeError(
                f"Database is missing required thread tables: {', '.join(sorted(missing))}."
            )
        required_columns = {
            table.name: set(table.c.keys())
            for table in (
                self.sessions,
                self.events,
                self.artifacts,
                self.run_token_usage,
                self.agent_runs,
                self.tombstones,
                self.workspace_files,
            )
        }
        for table_name, expected in required_columns.items():
            actual = {column["name"] for column in schema.get_columns(table_name)}
            absent = expected.difference(actual)
            if absent:
                raise RuntimeError(
                    f"Database table {table_name} is missing required columns: "
                    f"{', '.join(sorted(absent))}."
                )
        required_unique_constraints = {
            "session_events": {("session_id", "sequence")},
            "session_run_token_usage": {("session_id", "run_id")},
            "session_agent_runs": {("session_id", "run_id")},
        }
        for table_name, expected_unique in required_unique_constraints.items():
            actual_unique = {
                tuple(constraint.get("column_names") or ())
                for constraint in schema.get_unique_constraints(table_name)
            }
            absent_unique = expected_unique.difference(actual_unique)
            if absent_unique:
                rendered = ", ".join(
                    "(" + ", ".join(item) + ")" for item in sorted(absent_unique)
                )
                raise RuntimeError(
                    f"Database table {table_name} is missing required unique "
                    f"constraints: {rendered}."
                )
        if self.engine.dialect.name != "sqlite":
            if "alembic_version" not in schema.get_table_names():
                raise RuntimeError("Database is missing the Alembic migration version.")
            with self.engine.connect() as conn:
                revision = conn.scalar(text("SELECT version_num FROM alembic_version"))
            if revision is None or revision < self.REQUIRED_SCHEMA_REVISION:
                raise RuntimeError(
                    "Database migration is behind the required revision "
                    f"{self.REQUIRED_SCHEMA_REVISION} (found {revision or 'none'})."
                )










    def _notify_event(self, session_id: str) -> None:
        self._event_changes.fire(session_id)

    @contextmanager
    def mutation_scope(self, session_id: str) -> Iterator[None]:
        """Serialize validation and append with admission on other replicas."""
        with store_transaction(self.engine) as conn:
            self._session_pk(conn, _canonical_database_session_id(session_id), lock=True)
            yield





























    def _session_pk(self, conn: Any, session_id: str, *, lock: bool = False) -> str:
        statement = select(self.sessions.c.id).where(self.sessions.c.id == session_id)
        if lock:
            statement = statement.with_for_update()
        session_pk = conn.scalar(statement)
        if not session_pk:
            raise KeyError(session_id)
        return session_pk




Index("ix_session_events_cursor", DatabaseSessionStore.events.c.session_id,
      session_event_cursor_expression(DatabaseSessionStore.events))
