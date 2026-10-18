"""Thread artifacts: records, content snapshots in the blob store, and the workspace-file index.

A mixin of ``DatabaseSessionStore``; it shares the store's engine and tables
(declared on ``SessionStoreState``) and is not used on its own.
"""

from __future__ import annotations

import base64
import json
from typing import Any
from loguru import logger
from sqlalchemy import (
    insert,
    select,
    update,
)
from sqlalchemy.dialects.postgresql import insert as postgresql_insert
from sqlalchemy.dialects.sqlite import insert as sqlite_insert
from ..artifact_blobs import (
    artifact_blob_key,
    blob_metadata,
    read_blob_snapshot,
)
from ..store_common import (
    _format_iso,
    _parse_iso,
    apply_session_event,
    new_database_id,
    now_iso,
    relay_event,
    store_transaction,
)
from .rows import (
    artifact_snapshot_extension,
    compact_session_snapshot,
    database_artifact_uri,
    session_artifact_to_row,
    session_event_to_row,
    session_to_row,
    workspace_file_row,
)
from .state import SessionStoreState


class SessionArtifactRows(SessionStoreState):
    def list_artifact_summaries(
        self, *, owner_user_id: str | None = None,
        workspace_path: str | None = None, limit: int = 200
    ) -> list[dict[str, Any]]:
        # One indexed range read over the per-file projection: regenerated
        # files are already collapsed to their newest record, and no snapshot,
        # event history, or run log is touched.
        files, sessions = self.workspace_files, self.sessions
        statement = (
            select(
                files.c.artifact,
                files.c.session_id,
                files.c.owner_user_id,
                files.c.workspace_path,
                sessions.c.title,
                sessions.c.task_goal,
                sessions.c.updated_at,
            )
            .select_from(files.join(sessions, sessions.c.id == files.c.session_id))
            .order_by(
                files.c.created_at.desc(),
                files.c.session_id.desc(),
                files.c.artifact_id.desc(),
            )
            .limit(max(1, limit))
        )
        if owner_user_id is not None:
            statement = statement.where(files.c.owner_user_id == owner_user_id)
        if workspace_path is not None:
            statement = statement.where(files.c.workspace_path == workspace_path)
        with store_transaction(self.engine) as conn:
            rows = conn.execute(statement).mappings().all()
        result = []
        for row in rows:
            artifact = (
                row["artifact"]
                if isinstance(row["artifact"], dict)
                else json.loads(row["artifact"])
            )
            updated = row["updated_at"]
            result.append(
                {
                    **artifact,
                    "sessionId": str(row["session_id"]),
                    "sessionTitle": row["title"],
                    "taskGoal": row["task_goal"],
                    "ownerUserId": str(row["owner_user_id"])
                    if row["owner_user_id"]
                    else None,
                    "workspacePath": row["workspace_path"],
                    "sessionUpdatedAt": _format_iso(
                        _parse_iso(updated) if isinstance(updated, str) else updated
                    ),
                }
            )
        return result

    def _new_artifact_record(
        self, session_id: str, payload: dict[str, Any]
    ) -> tuple[dict[str, Any], str, str]:
        artifact_id = new_database_id()
        extension = payload.get("extension") or "txt"
        body = payload["body"]
        artifact = {
            "id": artifact_id,
            "kind": payload["kind"],
            "title": payload["title"],
            "path": database_artifact_uri(session_id, artifact_id, extension),
            "createdAt": now_iso(),
            **(
                {"agentRunId": payload["agentRunId"]}
                if payload.get("agentRunId")
                else {}
            ),
            "bytes": len(body.encode("utf-8")),
        }
        return artifact, extension, body

    def write_artifact(
        self, session_id: str, payload: dict[str, Any]
    ) -> dict[str, Any]:
        if not self.get_session(session_id):
            raise KeyError(session_id)
        artifact, extension, body = self._new_artifact_record(session_id, payload)
        with store_transaction(self.engine) as conn:
            session_pk = self._session_pk(conn, session_id)
            conn.execute(
                insert(self.artifacts).values(
                    **session_artifact_to_row(
                        session_pk, artifact, {"extension": extension}, content=body
                    )
                )
            )
        logger.debug(
            "Database artifact written",
            session_id=session_id,
            artifact_id=artifact["id"],
            kind=payload.get("kind"),
            bytes=artifact["bytes"],
        )
        return artifact

    def create_artifact(
        self, session_id: str, payload: dict[str, Any]
    ) -> tuple[dict[str, Any], dict[str, Any]]:
        artifact, extension, body = self._new_artifact_record(session_id, payload)
        session = self._insert_artifact_with_event(
            session_id, artifact, {"extension": extension}, content=body
        )
        logger.debug(
            "Database artifact created",
            session_id=session_id,
            artifact_id=artifact["id"],
            kind=payload.get("kind"),
            bytes=artifact["bytes"],
        )
        return artifact, session

    def index_workspace_artifact(
        self, session_id: str, artifact: dict[str, Any], content: bytes | None
    ) -> tuple[dict[str, Any], dict[str, Any]]:
        """Record a generated workspace file with an optional content snapshot.

        The bytes go to the blob store when one is configured, and otherwise
        into the artifacts table base64-encoded; either way the backend can
        serve them without access to the daemon's filesystem.
        """
        metadata: dict[str, Any] = {
            "extension": artifact_snapshot_extension(artifact.get("title"))
        }
        encoded: str | None = None
        blob_key: str | None = None
        if content is not None:
            artifact = {**artifact, "bytes": len(content)}
            if self.blob_store is not None:
                blob_key = self._upload_snapshot(session_id, artifact, content)
            if blob_key is not None:
                metadata.update(blob_metadata(blob_key, content))
            else:
                encoded = base64.b64encode(content).decode("ascii")
                metadata["contentEncoding"] = "base64"
        try:
            session = self._insert_artifact_with_event(
                session_id, artifact, metadata, content=encoded
            )
        except Exception:
            # Safe to discard: the registry mints a fresh artifact id per
            # index call, so no committed row can share this key.
            if blob_key is not None:
                self._discard_blob(blob_key)
            raise
        logger.debug(
            "Database workspace artifact indexed",
            session_id=session_id,
            artifact_id=artifact["id"],
            snapshot=content is not None,
        )
        return artifact, session

    def _insert_artifact_with_event(
        self,
        session_id: str,
        artifact: dict[str, Any],
        metadata: dict[str, Any],
        *,
        content: str | None,
    ) -> dict[str, Any]:
        event = relay_event("artifact.created", session_id, {"artifact": artifact})
        with store_transaction(self.engine) as conn:
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
            session_pk = row["id"]
            if event.get("type") == "session.deletion_requested" and (row["snapshot"] or {}).get("deletionRequestedAt"):
                return row["snapshot"]
            sequence = int(row["version"] or 0)
            conn.execute(
                insert(self.artifacts).values(
                    **session_artifact_to_row(
                        session_pk, artifact, metadata, content=content
                    )
                )
            )
            conn.execute(
                insert(self.events).values(
                    **session_event_to_row(session_pk, sequence, event)
                )
            )
            session = apply_session_event(
                compact_session_snapshot(
                    row["snapshot"] or {}, event_count=sequence + 1
                ),
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
            self._index_workspace_files(conn, session_pk, session, [artifact])
        return self.get_session(session_id)

    def _upload_snapshot(
        self, session_id: str, artifact: dict[str, Any], content: bytes
    ) -> str | None:
        """Upload a snapshot before its row exists; None keeps it inline.

        Uploading first means a committed row never points at bytes that are
        not there yet. A failed upload (a missing bucket, an R2 outage) falls
        back to the database, because indexing runs inside run finalization
        and raising here would leave the run finalizing forever.
        """
        assert self.blob_store is not None
        key = artifact_blob_key(session_id, artifact["id"])
        try:
            self.blob_store.put(key, content, content_type=artifact.get("contentType"))
        except Exception as error:  # noqa: BLE001 - botocore's ClientError, without importing it
            logger.error(
                "Blob store upload failed; keeping the artifact snapshot in the database",
                session_id=session_id,
                artifact_id=artifact["id"],
                blob_key=key,
                error=str(error),
            )
            return None
        return key

    def _discard_blob(self, key: str) -> None:
        assert self.blob_store is not None
        try:
            self.blob_store.delete(key)
        except Exception as error:  # noqa: BLE001 - the original failure matters more
            logger.warning("Could not remove an unindexed snapshot blob", blob_key=key, error=str(error))

    def read_artifact_content(self, session_id: str, artifact_id: str) -> bytes | None:
        """Return the stored snapshot bytes for an artifact, if one was kept."""
        with store_transaction(self.engine) as conn:
            session_pk = self._session_pk(conn, session_id)
            row = (
                conn.execute(
                    select(self.artifacts.c.content, self.artifacts.c.metadata)
                    .where(self.artifacts.c.session_id == session_pk)
                    .where(self.artifacts.c.id == artifact_id)
                )
                .mappings()
                .first()
            )
        if row and (row["metadata"] or {}).get("blobKey"):
            return read_blob_snapshot(self.blob_store, row["metadata"])
        if not row or row["content"] is None:
            return None
        if (row["metadata"] or {}).get("contentEncoding") == "base64":
            try:
                return base64.b64decode(row["content"], validate=True)
            except (ValueError, TypeError):
                return None
        return str(row["content"]).encode("utf-8")

    def read_artifact(self, session_id: str, artifact_id: str) -> str:
        with store_transaction(self.engine) as conn:
            session_pk = self._session_pk(conn, session_id)
            row = (
                conn.execute(
                    select(self.artifacts.c.content)
                    .where(self.artifacts.c.session_id == session_pk)
                    .where(self.artifacts.c.id == artifact_id)
                )
                .mappings()
                .first()
            )
        if row and row["content"] is not None:
            return row["content"]
        raise KeyError(f"Unknown artifact {artifact_id} in session {session_id}.")

    def _index_workspace_files(
        self,
        conn: Any,
        session_pk: str,
        session: dict[str, Any],
        artifacts: list[dict[str, Any]],
    ) -> None:
        """Keep session_workspace_files at the newest artifact per file.

        Artifacts are visited in log order, so on a createdAt tie the later
        one wins -- the same rank ``helpers.workspace_artifacts`` uses.
        """
        dialect_insert = (
            postgresql_insert if conn.dialect.name == "postgresql" else sqlite_insert
        )
        files = self.workspace_files
        for artifact in artifacts:
            row = workspace_file_row(session_pk, session, artifact)
            if row is None:
                continue
            statement = dialect_insert(files).values(**row)
            statement = statement.on_conflict_do_update(
                index_elements=[files.c.session_id, files.c.file_key],
                set_={
                    key: statement.excluded[key]
                    for key in ("artifact_id", "created_at", "artifact")
                },
                where=statement.excluded.created_at >= files.c.created_at,
            )
            conn.execute(statement)
