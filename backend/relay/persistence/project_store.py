from __future__ import annotations

from collections.abc import Callable
from typing import Any

from sqlalchemy import (
    BigInteger,
    Boolean,
    Column,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    Table,
    Text,
    UniqueConstraint,
    delete,
    insert,
    select,
    text,
    update,
)
from sqlalchemy.exc import IntegrityError

from ..core.ids import new_database_id, now_iso
from .store_common import (
    _format_iso,
    _parse_iso,
    create_all_tables,
    database_id_column,
    entity_uuid_type,
    json_type,
    shared_engine,
    store_transaction,
)
from .store_common import metadata as shared_metadata

PROJECT_NAME_MAX_LENGTH = 120


class ProjectValidationError(ValueError):
    def __init__(self, code: str, message: str | None = None):
        self.code = code
        super().__init__(message or code)


class ProjectVersionConflict(RuntimeError):
    pass


class _ProjectWriteConflict(RuntimeError):
    pass


class DatabaseProjectStore:
    """Event-authoritative projects with roster rows as a query projection."""

    metadata = shared_metadata
    projects = Table(
        "projects",
        metadata,
        database_id_column(),
        Column(
            "owner_user_id",
            entity_uuid_type(),
            ForeignKey("users.id", ondelete="RESTRICT", name="fk_projects_owner"),
            nullable=False,
        ),
        Column("name", Text, nullable=False),
        Column("name_key", Text, nullable=False),
        Column("computer_id", Text, nullable=False),
        Column("workspace_subpath", Text, nullable=False),
        Column("lead_agent_id", entity_uuid_type(), nullable=True),
        Column("enabled", Boolean, nullable=False),
        Column("snapshot", json_type(), nullable=False),
        Column("event_version", BigInteger, nullable=False),
        Column("created_at", DateTime(timezone=True), nullable=False),
        Column("updated_at", DateTime(timezone=True), nullable=False),
        Column("archived_at", DateTime(timezone=True), nullable=True),
        Index("ix_projects_owner_updated", "owner_user_id", "updated_at"),
        Index(
            "uq_projects_live_owner_name",
            "owner_user_id",
            "name_key",
            unique=True,
            postgresql_where=text("archived_at IS NULL"),
            sqlite_where=text("archived_at IS NULL"),
        ),
    )
    members = Table(
        "project_members",
        metadata,
        database_id_column(),
        Column(
            "project_id",
            entity_uuid_type(),
            ForeignKey("projects.id", ondelete="CASCADE"),
            nullable=False,
        ),
        # Agent storage is file-backed in the default local deployment, so this
        # projection deliberately does not own a database FK to agents.
        Column("agent_id", entity_uuid_type(), nullable=False),
        Column("role", Text, nullable=False),
        Column("responsibilities", Text, nullable=False),
        Column("instructions", Text, nullable=True),
        Column("enabled", Boolean, nullable=False),
        Column("position", Integer, nullable=False),
        UniqueConstraint("project_id", "agent_id", name="uq_project_members_agent"),
        Index("ix_project_members_agent", "agent_id"),
    )
    events_table = Table(
        "project_events",
        metadata,
        database_id_column(),
        Column(
            "project_id",
            entity_uuid_type(),
            ForeignKey("projects.id", ondelete="CASCADE"),
            nullable=False,
        ),
        Column("sequence", BigInteger, nullable=False),
        Column("type", Text, nullable=False),
        Column("timestamp", DateTime(timezone=True), nullable=False),
        Column("payload", json_type(), nullable=False),
        UniqueConstraint("project_id", "sequence", name="uq_project_events_sequence"),
    )

    def __init__(self, database_url: str, *, create_schema: bool = False):
        self.engine = shared_engine(database_url)
        if create_schema:
            create_all_tables(self.engine)

    def create_project(
        self, owner_user_id: str, payload: dict[str, Any]
    ) -> dict[str, Any]:
        project = _new_project(owner_user_id, payload)
        event = _project_event(project["id"], "project.created", {"project": project})
        try:
            with store_transaction(self.engine) as conn:
                conn.execute(insert(self.projects).values(**_project_row(project)))
                self._replace_members(conn, project)
                conn.execute(
                    insert(self.events_table).values(
                        **_event_row(project["id"], 0, event)
                    )
                )
        except IntegrityError as error:
            if _is_name_conflict(error):
                raise ProjectValidationError("project_name_taken") from error
            raise
        return project

    def get_project(self, project_id: str) -> dict[str, Any] | None:
        with store_transaction(self.engine) as conn:
            row = (
                conn.execute(
                    select(self.projects.c.snapshot).where(
                        self.projects.c.id == project_id
                    )
                )
                .mappings()
                .first()
            )
        return dict(row["snapshot"]) if row else None

    def list_projects(
        self,
        owner_user_id: str | None = None,
        *,
        include_archived: bool = False,
    ) -> list[dict[str, Any]]:
        statement = select(self.projects.c.snapshot)
        if owner_user_id is not None:
            statement = statement.where(
                self.projects.c.owner_user_id == owner_user_id
            )
        if not include_archived:
            statement = statement.where(self.projects.c.archived_at.is_(None))
        with store_transaction(self.engine) as conn:
            rows = conn.execute(statement).mappings().all()
        return sorted(
            (dict(row["snapshot"]) for row in rows),
            key=lambda project: (project["name"].casefold(), project["id"]),
        )

    def update_project(
        self,
        project_id: str,
        patch: dict[str, Any],
        *,
        expected_version: int,
    ) -> dict[str, Any]:
        normalized = _normalize_project_patch(patch)

        def mutate(current: dict[str, Any]) -> tuple[dict[str, Any], dict[str, Any]]:
            updated = {
                **current,
                **normalized,
                "version": int(current["version"]) + 1,
                "updatedAt": now_iso(),
            }
            return updated, {"patch": normalized, "project": updated}

        return self._mutate(
            project_id,
            "project.updated",
            expected_version=expected_version,
            mutate=mutate,
        )

    def record_setup(self, project_id: str, setup: dict[str, Any]) -> dict[str, Any]:
        """Record an agent-drafted setup's progress on the project."""
        return self.mutate_setup(project_id, lambda _latest: setup)

    def mutate_setup(
        self,
        project_id: str,
        change: Callable[[dict[str, Any]], dict[str, Any] | None],
    ) -> dict[str, Any]:
        """Transition a setup against the locked project; None means no change.

        Re-evaluate on a version conflict, so results cannot overwrite an
        owner's resolution or a newer draft between reading and recording.
        """

        def fields(latest: dict[str, Any]) -> dict[str, Any] | None:
            setup = change(latest)
            return {"setup": setup} if setup is not None else None

        return self._mutate_current(project_id, "project.setup_recorded", fields)

    def add_context_suggestions(
        self,
        project_id: str,
        merge: Callable[[dict[str, Any]], list[dict[str, Any]]],
    ) -> dict[str, Any]:
        """Record context lines a run proposed; `merge` folds them into the
        latest pending list so concurrent runs never drop each other's."""
        return self._mutate_current(
            project_id,
            "project.context_suggested",
            lambda latest: {"contextSuggestions": merge(latest)},
        )

    def _mutate_current(
        self,
        project_id: str,
        event_type: str,
        change: Callable[[dict[str, Any]], dict[str, Any] | None],
    ) -> dict[str, Any]:
        """Apply an execution-plane change against whatever revision is current.

        Run results do not come from an editor holding a revision. The change
        still bumps the version, so an editor's stale save surfaces as the
        usual conflict instead of erasing what the run recorded.
        """
        for _ in range(3):
            current = self.get_project(project_id)
            if current is None:
                raise KeyError(project_id)

            def mutate(
                latest: dict[str, Any],
            ) -> tuple[dict[str, Any], dict[str, Any]] | None:
                fields = change(latest)
                if fields is None:
                    return None
                updated = {
                    **latest,
                    **fields,
                    "version": int(latest["version"]) + 1,
                    "updatedAt": now_iso(),
                }
                return updated, {**fields, "project": updated}

            try:
                return self._mutate(
                    project_id,
                    event_type,
                    expected_version=int(current["version"]),
                    mutate=mutate,
                )
            except ProjectVersionConflict:
                if current.get("archivedAt"):
                    raise
        raise ProjectVersionConflict(project_id)

    def archive_project(
        self, project_id: str, *, expected_version: int
    ) -> dict[str, Any]:
        def mutate(current: dict[str, Any]) -> tuple[dict[str, Any], dict[str, Any]]:
            timestamp = now_iso()
            archived = {
                **current,
                "enabled": False,
                "archivedAt": timestamp,
                "updatedAt": timestamp,
                "version": int(current["version"]) + 1,
            }
            return archived, {"project": archived}

        return self._mutate(
            project_id,
            "project.archived",
            expected_version=expected_version,
            mutate=mutate,
        )

    def events(self, project_id: str) -> list[dict[str, Any]]:
        with store_transaction(self.engine) as conn:
            rows = (
                conn.execute(
                    select(
                        self.events_table.c.id,
                        self.events_table.c.type,
                        self.events_table.c.timestamp,
                        self.events_table.c.payload,
                    )
                    .where(self.events_table.c.project_id == project_id)
                    .order_by(self.events_table.c.sequence)
                )
                .mappings()
                .all()
            )
        if not rows and not self.get_project(project_id):
            raise KeyError(project_id)
        return [
            {
                "id": str(row["id"]),
                "type": row["type"],
                "projectId": project_id,
                "timestamp": _format_iso(row["timestamp"]),
                **row["payload"],
            }
            for row in rows
        ]

    def _mutate(
        self,
        project_id: str,
        event_type: str,
        *,
        expected_version: int,
        mutate: Callable[[dict[str, Any]], tuple[dict[str, Any], dict[str, Any]] | None],
    ) -> dict[str, Any]:
        for attempt in range(3):
            try:
                with store_transaction(self.engine) as conn:
                    row = (
                        conn.execute(
                            select(
                                self.projects.c.id,
                                self.projects.c.snapshot,
                                self.projects.c.event_version,
                            )
                            .where(self.projects.c.id == project_id)
                            .with_for_update()
                        )
                        .mappings()
                        .first()
                    )
                    if not row:
                        raise KeyError(project_id)
                    if row["snapshot"].get("archivedAt"):
                        raise ProjectVersionConflict(project_id)
                    current = dict(row["snapshot"])
                    if int(current["version"]) != expected_version:
                        raise ProjectVersionConflict(project_id)
                    result = mutate(current)
                    if result is None:
                        return current
                    project, payload = result
                    sequence = int(row["event_version"])
                    claimed = conn.execute(
                        update(self.projects)
                        .where(
                            self.projects.c.id == row["id"],
                            self.projects.c.event_version == sequence,
                        )
                        .values(**_project_row(project, database_id=row["id"]))
                    )
                    if claimed.rowcount != 1:
                        raise _ProjectWriteConflict(project_id)
                    self._replace_members(conn, project)
                    event = _project_event(project_id, event_type, payload)
                    conn.execute(
                        insert(self.events_table).values(
                            **_event_row(row["id"], sequence, event)
                        )
                    )
                return project
            except _ProjectWriteConflict:
                if attempt == 2:
                    raise
            except IntegrityError as error:
                if _is_name_conflict(error):
                    raise ProjectValidationError("project_name_taken") from error
                raise
        raise _ProjectWriteConflict(project_id)

    def _replace_members(self, conn: Any, project: dict[str, Any]) -> None:
        conn.execute(
            delete(self.members).where(self.members.c.project_id == project["id"])
        )
        rows = [
            {
                "id": new_database_id(),
                "project_id": project["id"],
                "agent_id": member["agentId"],
                "role": member["role"],
                "responsibilities": member["responsibilities"],
                "instructions": member.get("instructions"),
                "enabled": member.get("enabled", True),
                "position": position,
            }
            for position, member in enumerate(project["members"])
        ]
        if rows:
            conn.execute(insert(self.members), rows)


def _new_project(owner_user_id: str, payload: dict[str, Any]) -> dict[str, Any]:
    project_id = new_database_id()
    timestamp = now_iso()
    return {
        "id": project_id,
        "ownerUserId": owner_user_id,
        "name": _required_text(
            payload.get("name"),
            "project_name_required",
            max_length=PROJECT_NAME_MAX_LENGTH,
        ),
        "description": payload.get("description") or "",
        "goal": payload.get("goal") or "",
        "context": payload.get("context") or "",
        "contextRevision": 1 if payload.get("context") else 0,
        "computerId": _required_text(
            payload.get("computerId"), "project_computer_required"
        ),
        "workspaceLayout": "project",
        "workspaceSubpath": payload.get("workspaceSubpath") or f"projects/{project_id}",
        "leadAgentId": payload.get("leadAgentId"),
        "members": list(payload["members"]),
        "enabled": payload.get("enabled") is not False,
        "version": 1,
        "createdAt": timestamp,
        "updatedAt": timestamp,
    }


def _normalize_project_patch(patch: dict[str, Any]) -> dict[str, Any]:
    allowed = {
        "name",
        "description",
        "goal",
        "context",
        "contextRevision",
        "setup",
        "contextSuggestions",
        "leadAgentId",
        "members",
        "enabled",
    }
    unknown = set(patch) - allowed
    if unknown:
        raise ProjectValidationError("project_patch_unsupported")
    normalized = dict(patch)
    if "name" in normalized:
        normalized["name"] = _required_text(
            normalized["name"],
            "project_name_required",
            max_length=PROJECT_NAME_MAX_LENGTH,
        )
    if "enabled" in normalized and not isinstance(normalized["enabled"], bool):
        raise ProjectValidationError("project_enabled_invalid")
    for key in ("description", "goal", "context"):
        if key in normalized and not isinstance(normalized[key], str):
            raise ProjectValidationError(f"project_{key}_invalid")
    if "setup" in normalized and not isinstance(normalized["setup"], dict):
        raise ProjectValidationError("project_setup_invalid")
    if "contextRevision" in normalized and (
        not isinstance(normalized["contextRevision"], int)
        or isinstance(normalized["contextRevision"], bool)
    ):
        raise ProjectValidationError("project_context_revision_invalid")
    return normalized


def _required_text(value: Any, code: str, *, max_length: int | None = None) -> str:
    if not isinstance(value, str) or not value.strip():
        raise ProjectValidationError(code)
    normalized = value.strip()
    if max_length is not None and len(normalized) > max_length:
        raise ProjectValidationError("project_name_too_long")
    return normalized


def _project_row(
    project: dict[str, Any], *, database_id: str | None = None
) -> dict[str, Any]:
    return {
        "id": database_id or project["id"],
        "owner_user_id": project["ownerUserId"],
        "name": project["name"],
        "name_key": project["name"].casefold(),
        "computer_id": project["computerId"],
        "workspace_subpath": project["workspaceSubpath"],
        "lead_agent_id": project["leadAgentId"],
        "enabled": project.get("enabled", True),
        "snapshot": project,
        "event_version": project["version"],
        "created_at": _parse_iso(project["createdAt"]),
        "updated_at": _parse_iso(project["updatedAt"]),
        "archived_at": _parse_iso(project.get("archivedAt")),
    }


def _project_event(
    project_id: str, event_type: str, payload: dict[str, Any]
) -> dict[str, Any]:
    return {
        "id": new_database_id(),
        "type": event_type,
        "projectId": project_id,
        "timestamp": now_iso(),
        **payload,
    }


def _event_row(
    project_database_id: str, sequence: int, event: dict[str, Any]
) -> dict[str, Any]:
    return {
        "id": event["id"],
        "project_id": project_database_id,
        "sequence": sequence,
        "type": event["type"],
        "timestamp": _parse_iso(event["timestamp"]),
        "payload": {
            key: value
            for key, value in event.items()
            if key not in {"id", "type", "projectId", "timestamp"}
        },
    }


def _is_name_conflict(error: IntegrityError) -> bool:
    message = str(error).lower()
    return "uq_projects_live_owner_name" in message or "projects.name_key" in message
