from __future__ import annotations

from collections.abc import Callable, Collection
from datetime import UTC, date, tzinfo
from itertools import batched
from typing import Any

from sqlalchemy import (
    and_,
    case,
    delete,
    func,
    insert,
    or_,
    select,
    update,
)
from sqlalchemy.exc import IntegrityError

from ...core.ids import new_database_id, now_iso
from ...core.project_directory import PROJECT_DIRECTORY_FIELDS
from ...core.project_predefined_workflows import prune_removed_members, valid_predefined_workflows
from ...core.reporting_period import range_utc_bounds
from ...projects.setup_result import generated_setup_name
from ..db_time import format_db_time, parse_db_time
from ..engine import create_all_tables, shared_engine, store_transaction
from ..sql import metadata as shared_metadata, names_no_uuid_row
from ..tables import projects as projects_tables
from ..tables.sessions import sessions as sessions_table
from ..tables.tasks import tasks as tasks_table
from ...core.workspace_layout import LINKED_WORKSPACE_PREFIX
from .manager import ManagerRows
from .tool_reads import ProjectToolReads
from ...core.project_roles import project_with_manager

PROJECT_NAME_MAX_LENGTH = 120
# A project that links an existing directory on its computer names it under
# this subpath namespace; the daemon owns the mapping (`project-links.ts`).


class ProjectValidationError(ValueError):
    def __init__(self, code: str, message: str | None = None):
        self.code = code
        super().__init__(message or code)


class ProjectVersionConflict(RuntimeError):
    pass


class _ProjectWriteConflict(RuntimeError):
    pass


class DatabaseProjectStore(ManagerRows, ProjectToolReads):
    """Event-authoritative projects with roster rows as a query projection."""

    metadata = shared_metadata
    projects = projects_tables.projects
    members = projects_tables.members
    events_table = projects_tables.events_table

    def __init__(self, database_url: str, *, create_schema: bool = False):
        self.engine = shared_engine(database_url)
        if create_schema:
            create_all_tables(self.engine)

    def create_project(
        self, owner_user_id: str, payload: dict[str, Any]
    ) -> dict[str, Any]:
        project = project_with_manager(_new_project(owner_user_id, payload))
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

    def get_project(self, project_id: str, *, for_update: bool = False) -> dict[str, Any] | None:
        if names_no_uuid_row(self.engine, project_id):
            return None
        statement = select(self.projects.c.snapshot).where(self.projects.c.id == project_id)
        if for_update:
            statement = statement.with_for_update()
        with store_transaction(self.engine) as conn:
            row = conn.execute(statement).mappings().first()
        return project_with_manager(dict(row["snapshot"])) if row else None

    def list_projects(
        self,
        owner_user_id: str | None = None,
        *,
        include_archived: bool = False,
        project_ids: Collection[str] | None = None,
        computer_id: str | None = None,
    ) -> list[dict[str, Any]]:
        statement = select(self.projects.c.snapshot)
        if owner_user_id is not None:
            statement = statement.where(
                self.projects.c.owner_user_id == owner_user_id
            )
        if not include_archived:
            statement = statement.where(self.projects.c.archived_at.is_(None))
        if computer_id is not None:
            statement = statement.where(self.projects.c.computer_id == computer_id)
        if project_ids is not None:
            project_ids = {key for key in project_ids if not names_no_uuid_row(self.engine, key)}
            if not project_ids:
                return []
        with store_transaction(self.engine) as conn:
            rows = (
                conn.execute(statement).mappings().all() if project_ids is None else [
                    row for batch in batched(sorted(project_ids), 500, strict=False)
                    for row in conn.execute(statement.where(self.projects.c.id.in_(batch))).mappings()
                ]
            )
        return sorted(
            (project_with_manager(dict(row["snapshot"])) for row in rows),
            key=lambda project: (project["name"].casefold(), project["id"]),
        )

    def list_project_directory(self, owner_user_id: str) -> list[dict[str, Any]]:
        """Read directory metadata and roster roles without transferring Project text or proposals."""
        projects, members = self.projects, self.members
        snapshot = projects.c.snapshot
        suggestions = snapshot["contextSuggestions"]
        setup = snapshot["setup"]
        proposal = setup["proposal"]
        proposed_tasks = proposal["tasks"]
        # The roster rows and snapshot share the same member order.
        role_level = snapshot["members"].op("->")(members.c.position)["roleLevel"].as_string()
        setup_fields = ("state", "mode", "threadId")
        fields = tuple(key for key in PROJECT_DIRECTORY_FIELDS if key != "managerAgentId")
        with store_transaction(self.engine) as conn:
            suggestion_count: Any
            proposed_task_count: Any
            if conn.dialect.name == "postgresql":
                suggestion_count = case(
                    (func.jsonb_typeof(suggestions) == "array", func.jsonb_array_length(suggestions)), else_=0,
                )
                proposed_task_count = case(
                    (func.jsonb_typeof(proposed_tasks) == "array", func.jsonb_array_length(proposed_tasks)), else_=0,
                )
            else:
                suggestion_count = func.coalesce(func.json_array_length(suggestions), 0)
                proposed_task_count = func.coalesce(func.json_array_length(proposed_tasks), 0)
            statement = select(
                *(snapshot[key].label(key) for key in fields),
                suggestion_count.label("suggestion_count"),
                setup.as_string().not_in(("", "{}")).label("has_setup"),
                proposal.as_string().not_in(("", "{}")).label("has_proposal"),
                proposed_task_count.label("proposed_task_count"),
                *(setup[key].label(f"setup_{key}") for key in setup_fields),
                members.c.agent_id, members.c.role, role_level.label("member_role_level"),
                members.c.enabled.label("member_enabled"),
            ).select_from(projects.outerjoin(members, members.c.project_id == projects.c.id)).where(
                projects.c.owner_user_id == owner_user_id,
            ).order_by(projects.c.name_key, projects.c.id, members.c.position)
            directory: dict[str, dict[str, Any]] = {}
            for row in conn.execute(statement).mappings():
                project_id = row["id"]
                project = directory.get(project_id)
                if project is None:
                    project = {key: row[key] for key in fields if row[key] is not None or key in ("leadAgentId", "managerThreadId")}
                    project.update(view="directory", members=[])
                    if row["suggestion_count"]:
                        project["contextSummary"] = {"suggestionCount": row["suggestion_count"]}
                    if row["has_setup"]:
                        project["setupSummary"] = {
                            **{key: row[f"setup_{key}"] for key in setup_fields if row[f"setup_{key}"] is not None},
                            "hasProposal": bool(row["has_proposal"]),
                            **({"proposedTaskCount": row["proposed_task_count"]} if row["has_proposal"] else {}),
                        }
                    directory[project_id] = project
                if row["agent_id"] is not None:
                    member = {"agentId": row["agent_id"], "role": row["role"], "enabled": row["member_enabled"]}
                    if row["member_role_level"] is not None:
                        member["roleLevel"] = row["member_role_level"]
                    project["members"].append(member)
        return [project_with_manager(project) for project in directory.values()]

    def live_owned_project_ids(self, owner_user_id: str, project_ids: Collection[str]) -> set[str]:
        """Check ownership and archive state using only the requested Project IDs."""
        ids = [project_id for project_id in set(project_ids) if not names_no_uuid_row(self.engine, project_id)]
        if not ids:
            return set()
        columns = self.projects.c
        statement = select(columns.id).where(columns.owner_user_id == owner_user_id, columns.archived_at.is_(None))
        with store_transaction(self.engine) as conn:
            return {
                str(key)
                for batch in batched(ids, 500, strict=False)
                for key in conn.scalars(statement.where(columns.id.in_(batch)))
            }

    def agent_has_active_project(self, agent_id: str, *, exclude_computer_id: str | None = None) -> bool:
        if names_no_uuid_row(self.engine, agent_id):
            return False
        columns, members = self.projects.c, self.members.c
        statement = select(columns.id).join_from(
            self.members, self.projects, members.project_id == columns.id,
        ).where(members.agent_id == agent_id, columns.archived_at.is_(None))
        if exclude_computer_id is not None:
            statement = statement.where(columns.computer_id != exclude_computer_id)
        with store_transaction(self.engine) as conn:
            return conn.scalar(statement.limit(1)) is not None

    def workflow_projects(
        self, owner_user_id: str, computer_id: str | None, linked_ids: Collection[str],
    ) -> list[tuple[str, str, bool]]:
        columns = self.projects.c
        eligible = (columns.computer_id == computer_id) & columns.enabled & columns.archived_at.is_(None)
        valid_links = [project_id for project_id in linked_ids if not names_no_uuid_row(self.engine, project_id)]
        statement = select(columns.id, columns.name, eligible).where(
            columns.owner_user_id == owner_user_id, or_(eligible, columns.id.in_(valid_links)),
        ).order_by(columns.name_key, columns.id)
        with store_transaction(self.engine) as conn:
            return [(str(project_id), name, available) for project_id, name, available in conn.execute(statement)]

    def list_project_index(self, owner_user_id: str) -> list[dict[str, Any]]:
        columns = self.projects.c
        member_count = select(func.count()).where(self.members.c.project_id == columns.id).scalar_subquery()
        statement = select(
            columns.id, columns.name, columns.enabled, columns.event_version, columns.archived_at,
            member_count.label("member_count"),
        ).where(columns.owner_user_id == owner_user_id).order_by(columns.name_key, columns.id)
        with store_transaction(self.engine) as conn:
            return [{
                "id": str(row.id), "name": row.name, "enabled": row.enabled,
                "version": row.event_version, "memberCount": row.member_count,
                **({"archivedAt": format_db_time(row.archived_at)} if row.archived_at else {}),
            } for row in conn.execute(statement)]

    def dashboard_project_metrics(
        self,
        *,
        date_range: tuple[date, date] | None = None,
        zone: tzinfo = UTC,
        all_time: bool = False,
    ) -> dict[str, int]:
        """Aggregate project inventory and range activity without reading snapshots."""
        columns = self.projects.c
        live = columns.archived_at.is_(None)
        session_filters: list[Any] = [sessions_table.c.project_id == columns.id]
        task_filters: list[Any] = [
            tasks_table.c.project_id == columns.id,
            tasks_table.c.deleted_at.is_(None),
            tasks_table.c.is_routine.is_(False),
        ]
        created_in_range: Any = live
        if date_range is not None and not all_time:
            start_at, end_at = range_utc_bounds(date_range, zone)
            created_in_range = and_(live, columns.created_at >= start_at, columns.created_at < end_at)
            session_filters.extend([sessions_table.c.created_at >= start_at, sessions_table.c.created_at < end_at])
            task_filters.extend([tasks_table.c.created_at >= start_at, tasks_table.c.created_at < end_at])
        has_activity = or_(
            select(sessions_table.c.id).where(*session_filters).exists(),
            select(tasks_table.c.id).where(*task_filters).exists(),
        )
        statement = select(
            func.sum(case((live, 1), else_=0)).label("total"),
            func.sum(case((and_(live, columns.enabled.is_(True)), 1), else_=0)).label("enabled"),
            func.sum(case((and_(live, columns.enabled.is_(False)), 1), else_=0)).label("disabled"),
            func.sum(case((columns.archived_at.is_not(None), 1), else_=0)).label("archived"),
            func.sum(case((created_in_range, 1), else_=0)).label("created"),
            func.sum(case((and_(live, has_activity), 1), else_=0)).label("active_in_range"),
        ).select_from(self.projects)
        with store_transaction(self.engine) as conn:
            row = conn.execute(statement).mappings().one()
        return {
            "total": int(row["total"] or 0),
            "enabled": int(row["enabled"] or 0),
            "disabled": int(row["disabled"] or 0),
            "archived": int(row["archived"] or 0),
            "created": int(row["created"] or 0),
            "activeInRange": int(row["active_in_range"] or 0),
        }

    def list_linked_workspaces(self, computer_id: str) -> list[dict[str, str]]:
        """Every linked directory on one computer, archived projects included,
        in the shape the daemon's registration response carries."""
        projects = self.projects.c
        statement = select(
            projects.snapshot["workspaceSubpath"].as_string().label("workspaceSubpath"),
            projects.snapshot["workspaceHostPath"].as_string().label("hostPath"),
        ).where(
            projects.computer_id == computer_id,
            projects.workspace_subpath.startswith(LINKED_WORKSPACE_PREFIX),
        )
        with store_transaction(self.engine) as conn:
            rows = [dict(row) for row in conn.execute(statement).mappings() if row["hostPath"]]
        return sorted(rows, key=lambda link: link["workspaceSubpath"])

    def update_project(
        self,
        project_id: str,
        patch: dict[str, Any],
        *,
        expected_version: int,
    ) -> dict[str, Any]:
        normalized = _normalize_project_patch(patch)

        def mutate(current: dict[str, Any]) -> tuple[dict[str, Any], dict[str, Any]]:
            applied = dict(normalized)
            selections = applied.get("predefinedWorkflows", current.get("predefinedWorkflows"))
            if "members" in applied and selections:
                pruned = prune_removed_members(selections, applied["members"])
                if pruned != selections:
                    applied["predefinedWorkflows"] = pruned
            updated = {
                **current,
                **applied,
                "version": int(current["version"]) + 1,
                "updatedAt": now_iso(),
            }
            updated = project_with_manager(updated)
            return updated, {"patch": applied, "project": updated}

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

        include_name = True

        def fields(latest: dict[str, Any]) -> dict[str, Any] | None:
            setup = change(latest)
            if setup is None:
                return None
            name = generated_setup_name(latest, setup) if include_name else None
            return {"setup": setup, **(_normalize_project_patch({"name": name}) if name else {})}

        try:
            return self._mutate_current(project_id, "project.setup_recorded", fields)
        except ProjectValidationError as error:
            if error.code != "project_name_taken":
                raise
            # A naming collision must not lose the proposal. The owner can
            # choose another name when applying it; no suffix is invented.
            include_name = False
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

    def unarchive_project(
        self, project_id: str, *, expected_version: int
    ) -> dict[str, Any]:
        """Reopen an archived project as it stood, enabled again.

        Nothing about its roster or computer is re-checked here: dispatch
        admits work against the current agents and nodes as it always does.
        A live project with the same name refuses it (`project_name_taken`).
        """

        def mutate(
            current: dict[str, Any],
        ) -> tuple[dict[str, Any], dict[str, Any]] | None:
            if not current.get("archivedAt"):
                return None
            restored = {
                key: value for key, value in current.items() if key != "archivedAt"
            }
            restored = {
                **restored,
                "enabled": True,
                "updatedAt": now_iso(),
                "version": int(current["version"]) + 1,
            }
            return restored, {"project": restored}

        return self._mutate(
            project_id,
            "project.unarchived",
            expected_version=expected_version,
            mutate=mutate,
            allow_archived=True,
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
                "timestamp": format_db_time(row["timestamp"]),
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
        allow_archived: bool = False,
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
                    if row["snapshot"].get("archivedAt") and not allow_archived:
                        raise ProjectVersionConflict(project_id)
                    current = project_with_manager(dict(row["snapshot"]))
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
        **(
            {"workspaceHostPath": payload["workspaceHostPath"]}
            if payload.get("workspaceHostPath")
            else {}
        ),
        "leadAgentId": payload.get("leadAgentId"),
        "managerAgentId": payload.get("leadAgentId"),
        "managerThreadId": None,
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
        "predefinedWorkflows",
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
    if "predefinedWorkflows" in normalized and not valid_predefined_workflows(normalized["predefinedWorkflows"]):
        raise ProjectValidationError("project_workflow_change_invalid")
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
        "created_at": parse_db_time(project["createdAt"]),
        "updated_at": parse_db_time(project["updatedAt"]),
        "archived_at": parse_db_time(project.get("archivedAt")),
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
        "timestamp": parse_db_time(event["timestamp"]),
        "payload": {
            key: value
            for key, value in event.items()
            if key not in {"id", "type", "projectId", "timestamp"}
        },
    }


def _is_name_conflict(error: IntegrityError) -> bool:
    message = str(error).lower()
    return "uq_projects_live_owner_name" in message or "projects.name_key" in message
