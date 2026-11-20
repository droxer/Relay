"""Read collection fields for an Issues query and hydrate only the visible rows."""

from __future__ import annotations

from typing import Any

from sqlalchemy import Text, and_, cast, func, literal, or_, select
from sqlalchemy.sql.elements import ColumnElement

from ...core.issue_listing import IssueListRequest, issue_window, workspace_board_window
from .. import sql
from ..engine import store_transaction
from ..tables.agents import agents
from ..tables.projects import projects
from ..tables.teams import teams
from .computer_scope import bound_computer, computer_list_columns, latest_computer, linked_computers, with_effective_computers
from .rows import compact_task_summary
from .state import TaskStoreState


class TaskIssueRows(TaskStoreState):
    def linked_computer(self, owner: str, session_ids: list[str]) -> str | None:
        with store_transaction(self.engine) as conn:
            return latest_computer(session_ids, linked_computers(conn, owner, set(session_ids)))

    def issue_page(self, request: IssueListRequest) -> tuple[list[dict[str, Any]], dict[str, Any]]:
        tasks = self.tasks
        snapshot = tasks.c.snapshot
        relation = tasks.outerjoin(projects, projects.c.id == tasks.c.project_id)
        columns = [
            cast(tasks.c.id, Text).label("id"),
            tasks.c.title,
            tasks.c.number,
            tasks.c.status,
            tasks.c.priority,
            tasks.c.due_date.label("due"),
            tasks.c.created_at.label("created"),
            tasks.c.updated_at.label("updated"),
            cast(tasks.c.project_id, Text).label("project_id"),
            projects.c.name.label("project_name"),
            cast(tasks.c.assignee_user_id, Text).label("assignee"),
            tasks.c.assigned_agent.label("agent"),
            cast(tasks.c.assigned_agent_id, Text).label("agent_id"),
            cast(tasks.c.assigned_team_id, Text).label("team_id"),
            snapshot["computerId"].as_string().label("computer"),
            snapshot["sourceRoutineId"].as_string().label("source"),
            snapshot["tags"].label("tags"),
            snapshot["workflowStage"].as_string().label("stage"),
        ]
        if request.query:
            columns.append(tasks.c.description)
        if request.needs_assignee_names:
            relation = relation.outerjoin(agents, and_(
                agents.c.id == tasks.c.assigned_agent_id, agents.c.supervisor_user_id == request.owner,
                agents.c.enabled.is_(True), agents.c.deleted_at.is_(None),
            )).outerjoin(teams, and_(
                teams.c.id == tasks.c.assigned_team_id, teams.c.owner_user_id == request.owner,
                teams.c.deleted_at.is_(None),
            ))
            columns.extend([
                agents.c.display_name.label("agent_name"),
                teams.c.name.label("team_name"),
                snapshot["assignedWorkflowId"].as_string().label("workflow"),
            ])
        visible_project: ColumnElement[bool] = projects.c.archived_at.is_(None)
        if request.project_id:
            visible_project = or_(visible_project, cast(projects.c.id, Text) == request.project_id)
        scope = or_(tasks.c.project_id.is_(None), and_(projects.c.id.is_not(None), visible_project))
        if request.workspace_board:
            if request.project_id:
                if sql.names_no_uuid_row(self.engine, request.project_id):
                    return [], workspace_board_window([], request)[1]
                scope = tasks.c.project_id == request.project_id
            else:
                bound = bound_computer(snapshot)
                scope = and_(tasks.c.project_id.is_(None), or_(bound == request.computer_id, bound.is_(None)))
                columns.extend(computer_list_columns(snapshot, bound))
            scope = and_(scope, func.nullif(snapshot["sourceRoutineId"].as_string(), "").is_(None))
        metadata_rows = select(*columns).select_from(relation).where(
            tasks.c.owner_user_id == request.owner, tasks.c.deleted_at.is_(None), tasks.c.is_routine.is_(False),
            scope,
        ).order_by(tasks.c.updated_at.desc(), tasks.c.id.desc())
        with store_transaction(self.engine) as conn:
            metadata_rows_result = list(conn.execute(metadata_rows).mappings())
            if request.computer_id:
                scoped_rows = with_effective_computers(conn, request.owner, metadata_rows_result)
                ids, metadata = workspace_board_window(scoped_rows, request)
            elif request.workspace_board:
                ids, metadata = workspace_board_window(metadata_rows_result, request)
            else:
                ids, metadata = issue_window(metadata_rows_result, request)
            if not ids:
                return [], metadata
            rows = conn.execute(select(tasks.c.id, tasks.c.snapshot, tasks.c.version).where(
                tasks.c.id.in_(ids), tasks.c.owner_user_id == request.owner, tasks.c.deleted_at.is_(None),
            )).mappings()
            summaries = {
                row["id"]: compact_task_summary(
                    row["snapshot"], event_count=int(row["version"] or 0),
                    activity_count=int(row["snapshot"].get("activityCount") or 0),
                )
                for row in rows
            }
        return [summaries[key] for key in ids if key in summaries], metadata

    def prerequisite_choices(self, owner: str, project_id: str, task_ids: list[str] | None = None) -> list[dict[str, Any]]:
        tasks = self.tasks
        statement = select(tasks.c.id, tasks.c.title, tasks.c.number).where(
            tasks.c.owner_user_id == owner, tasks.c.project_id == project_id,
            tasks.c.deleted_at.is_(None), tasks.c.is_routine.is_(False),
        ).order_by(tasks.c.updated_at.desc(), tasks.c.id.desc())
        if task_ids is not None:
            statement = statement.where(tasks.c.id.in_(task_ids))
        with store_transaction(self.engine) as conn:
            return [dict(row) for row in conn.execute(statement).mappings()]

    def prerequisite_choice_page(
        self, owner: str, project_id: str, task_id: str, query: str, requested_page: int,
    ) -> dict[str, Any]:
        tasks, edges = self.tasks, self.task_prerequisites
        scope = and_(
            tasks.c.owner_user_id == owner, tasks.c.project_id == project_id, tasks.c.id != task_id,
            tasks.c.deleted_at.is_(None), tasks.c.is_routine.is_(False),
            ~select(edges.c.task_id).where(edges.c.task_id == task_id, edges.c.prerequisite_task_id == tasks.c.id).exists(),
            ~select(edges.c.task_id).where(edges.c.prerequisite_task_id == task_id, edges.c.task_id == tasks.c.id).exists(),
        )
        if query:
            reference = literal("#") + cast(tasks.c.number, Text)
            scope = and_(scope, or_(
                func.lower(tasks.c.title).contains(query, autoescape=True),
                reference.contains(query, autoescape=True),
                cast(tasks.c.id, Text).contains(query, autoescape=True),
            ))
        size = 25
        with store_transaction(self.engine) as conn:
            total = conn.execute(select(func.count()).select_from(tasks).where(scope)).scalar_one()
            page = min(requested_page, max(1, (total + size - 1) // size))
            rows = conn.execute(select(tasks.c.id, tasks.c.title, tasks.c.number).where(scope)
                .order_by(tasks.c.updated_at.desc(), tasks.c.id.desc()).offset((page - 1) * size).limit(size)).mappings()
            return {"tasks": [dict(row) for row in rows], "page": {"page": page, "total": total}}
