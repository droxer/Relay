"""Creating and importing threads, and pinning their runtime affinity.

A mixin of ``DatabaseSessionStore``; it shares the store's engine and tables
(declared on ``SessionStoreState``) and is not used on its own.
"""

from __future__ import annotations

from typing import Any
from loguru import logger
from sqlalchemy import (
    insert,
    select,
    update,
)
from sqlalchemy.exc import IntegrityError
from .reducer import SESSION_WORKSPACE_LAYOUT_THREAD, apply_session_event, materialize_events
from ...core.ids import new_database_id
from ..engine import publish_database_notification, store_transaction
from ..events import relay_event
from .rows import (
    compact_session_snapshot,
    session_artifact_to_row,
    session_event_to_row,
    session_to_row,
)
from .state import SessionStoreState


class SessionLifecycleRows(SessionStoreState):
    def create_session(self, payload: dict[str, Any]) -> dict[str, Any]:
        session_id = payload.get("id") or new_database_id()
        logger.debug(
            "Creating database session",
            session_id=session_id,
            workspace_path=payload.get("workspacePath"),
        )
        events = [
            relay_event(
                "session.created",
                session_id,
                {
                    "workspacePath": payload["workspacePath"],
                    "workspaceLayout": payload.get(
                        "workspaceLayout", SESSION_WORKSPACE_LAYOUT_THREAD
                    ),
                    **(
                        {"ownerUserId": payload["ownerUserId"]}
                        if payload.get("ownerUserId")
                        else {}
                    ),
                    **(
                        {"ownerAgentId": payload["ownerAgentId"]}
                        if payload.get("ownerAgentId")
                        else {}
                    ),
                    **({"teamId": payload["teamId"]} if payload.get("teamId") else {}),
                    **(
                        {"projectId": payload["projectId"]}
                        if payload.get("projectId")
                        else {}
                    ),
                    **(
                        {"workspaceSubpath": payload["workspaceSubpath"]}
                        if payload.get("workspaceSubpath")
                        else {}
                    ),
                    **(
                        {"daemonNodeId": payload["daemonNodeId"]}
                        if payload.get("daemonNodeId")
                        else {}
                    ),
                    **(
                        {"managedNodeId": payload["managedNodeId"]}
                        if payload.get("managedNodeId")
                        else {}
                    ),
                    **(
                        {"computerId": payload["computerId"]}
                        if payload.get("computerId")
                        else (
                            {"computerId": f"managed:{payload['managedNodeId']}"}
                            if payload.get("managedNodeId")
                            else {}
                        )
                    ),
                    "taskGoal": payload["taskGoal"],
                    "participants": payload.get("participants", ["human"]),
                },
            )
        ]
        if payload.get("status") or payload.get("pendingDecision"):
            events.append(
                relay_event(
                    "session.status",
                    session_id,
                    {
                        "status": payload.get("status", "running"),
                        "phase": f"waiting:{payload['pendingDecision']}"
                        if payload.get("pendingDecision")
                        else "created",
                        **(
                            {"pendingDecision": payload["pendingDecision"]}
                            if payload.get("pendingDecision")
                            else {}
                        ),
                    },
                )
            )
        session = materialize_events(events)
        try:
            with store_transaction(self.engine) as conn:
                session_row = session_to_row(session, version=len(events))
                conn.execute(insert(self.sessions).values(**session_row))
                for sequence, event in enumerate(events):
                    conn.execute(
                        insert(self.events).values(
                            **session_event_to_row(session_row["id"], sequence, event)
                        )
                    )
        except IntegrityError:
            if payload.get("id"):
                return self.get_session(session_id)
            raise
        return session

    def import_session(
        self,
        events: list[dict[str, Any]],
        artifact_contents: dict[str, tuple[str | None, dict[str, Any]]],
    ) -> str:
        """Import one validated legacy event log atomically.

        Returns ``imported`` or ``skipped``. Existing divergent histories are
        rejected; import never overwrites database state.
        """
        session = materialize_events(events)
        session_id = session["id"]
        with store_transaction(self.engine) as conn:
            outcome = self._existing_import_outcome(conn, session_id, events)
            if outcome:
                return outcome
            self._insert_import_session(conn, session, events, artifact_contents)
        return "imported"

    def validate_import_session(
        self,
        events: list[dict[str, Any]],
        artifact_contents: dict[str, tuple[str | None, dict[str, Any]]],
    ) -> str:
        """Exercise the real import inserts in a transaction that is rolled back."""
        session = materialize_events(events)
        conn = self.engine.connect()
        transaction = conn.begin()
        try:
            outcome = self._existing_import_outcome(conn, session["id"], events)
            if outcome:
                return outcome
            self._insert_import_session(conn, session, events, artifact_contents)
            return "validated"
        finally:
            transaction.rollback()
            conn.close()

    def _existing_import_outcome(
        self, conn: Any, session_id: str, events: list[dict[str, Any]]
    ) -> str | None:
        existing = (
            conn.execute(
                select(self.sessions.c.id).where(self.sessions.c.id == session_id)
            )
            .mappings()
            .first()
        )
        if not existing:
            return None
        if self._events_for_session(conn, existing["id"]) == events:
            return "skipped"
        raise ValueError(f"Database session {session_id} has divergent history.")

    def _insert_import_session(
        self,
        conn: Any,
        session: dict[str, Any],
        events: list[dict[str, Any]],
        artifact_contents: dict[str, tuple[str | None, dict[str, Any]]],
    ) -> None:
        session_row = session_to_row(session, version=len(events))
        conn.execute(insert(self.sessions).values(**session_row))
        for sequence, event in enumerate(events):
            conn.execute(
                insert(self.events).values(
                    **session_event_to_row(session_row["id"], sequence, event)
                )
            )
        for artifact in session.get("artifacts", []):
            content, metadata = artifact_contents.get(artifact["id"], (None, {}))
            conn.execute(
                insert(self.artifacts).values(
                    **session_artifact_to_row(
                        session_row["id"], artifact, metadata, content=content
                    )
                )
            )
        self._index_workspace_files(
            conn, session_row["id"], session, session.get("artifacts", [])
        )
        for run in session.get("agentRuns", []):
            if run.get("id"):
                self._insert_agent_run(conn, session_row["id"], run)
                self._sync_run_token_usage(
                    conn, session_row["id"], session, str(run["id"])
                )

    def record_runtime_affinity(
        self, session_id: str, computer_id: str
    ) -> dict[str, Any]:
        event = relay_event(
            "session.runtime_affinity", session_id, {"computerId": computer_id}
        )
        wrote_event = False
        with self._affinity_lock, store_transaction(self.engine) as conn:
            row = (
                conn.execute(
                    select(
                        self.sessions.c.id,
                        self.sessions.c.snapshot,
                        self.sessions.c.version,
                    )
                    .where(self.sessions.c.id == session_id)
                    .with_for_update()
                )
                .mappings()
                .first()
            )
            if not row:
                raise KeyError(session_id)
            current = row["snapshot"] or {}
            existing = current.get("computerId")
            if existing:
                if existing != computer_id:
                    raise ValueError("Session already belongs to another Computer.")
            else:
                existing_managed_node_id = current.get("managedNodeId")
                if (
                    existing_managed_node_id
                    and computer_id != f"managed:{existing_managed_node_id}"
                ):
                    raise ValueError("Session already belongs to another Computer.")
                session_pk = row["id"]
                sequence = int(row["version"] or 0)
                conn.execute(
                    insert(self.events).values(
                        **session_event_to_row(session_pk, sequence, event)
                    )
                )
                session = apply_session_event(
                    compact_session_snapshot(current, event_count=sequence + 1),
                    event,
                    retain_event=False,
                )
                conn.execute(
                    update(self.sessions)
                    .where(self.sessions.c.id == session_pk)
                    .values(
                        **session_to_row(
                            session, version=sequence + 1, database_id=session_pk
                        )
                    )
                )
                publish_database_notification(
                    conn,
                    self.engine,
                    self._event_changes.database_channel,
                    f"session:{session_id}",
                )
                wrote_event = True
        if wrote_event:
            self._notify_event(session_id)
        return self.get_session(session_id)
