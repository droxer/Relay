"""Read a numbered Automation list without loading occurrence records."""

from __future__ import annotations

from collections import defaultdict
from collections.abc import Sequence
from typing import Any

from sqlalchemy import Connection, and_, or_, select
from sqlalchemy.sql import Select

from ...automations.model import TRIGGER_KINDS, triggers_of
from ...core.automation_listing import (
    LIVE_OCCURRENCE_STATUSES,
    RUNNING_OCCURRENCE_STATUSES,
    AutomationListRequest,
    AutomationRow,
    automation_window,
)
from .. import sql
from ..engine import store_transaction
from ..tables.agents import agents
from ..tables.projects import projects
from ..tables.teams import teams
from .computer_scope import bound_computer, computer_list_columns, with_effective_computers
from .state import TaskStoreState


class TaskAutomationPages(TaskStoreState):
    def _automation_occurrence_statuses(self, owner: str) -> Select[Any]:
        tasks = self.tasks
        source = tasks.c.snapshot["sourceRoutineId"].as_string()
        return select(source.label("source"), tasks.c.status).where(
            tasks.c.owner_user_id == owner, tasks.c.deleted_at.is_(None), tasks.c.is_routine.is_(False),
            tasks.c.status.in_(LIVE_OCCURRENCE_STATUSES), source.is_not(None), source != "",
        )

    def _automation_states(self, conn: Connection, request: AutomationListRequest) -> dict[str, set[str]]:
        occurrences = self._automation_occurrence_statuses(request.owner)
        if request.project_id:
            occurrences = occurrences.where(self.tasks.c.project_id == request.project_id)
        elif request.computer_id:
            occurrences = occurrences.where(self.tasks.c.project_id.is_(None))
        result: dict[str, set[str]] = defaultdict(set)
        for parent, status in conn.execute(occurrences.distinct()):
            result[parent].add(status)
        return result

    def automation_page(self, request: AutomationListRequest) -> tuple[list[dict[str, Any]], dict[str, Any]]:
        if request.project_id and sql.names_no_uuid_row(self.engine, request.project_id):
            return [], automation_window([], {}, request)[1]
        tasks = self.tasks
        snapshot = tasks.c.snapshot
        relation = tasks.outerjoin(projects, projects.c.id == tasks.c.project_id)
        scope = or_(tasks.c.project_id.is_(None), projects.c.id.is_not(None))
        columns = [
            tasks.c.id, tasks.c.title, tasks.c.number, tasks.c.priority,
            tasks.c.routine_state, tasks.c.routine_next_run_at.label("next_run"),
            tasks.c.assignee_user_id.label("assignee"), tasks.c.assigned_agent_id.label("agent_id"),
            snapshot["routineTriggers"].label("routineTriggers"), snapshot["tags"].label("tags"),
        ]
        if request.search:
            columns.append(tasks.c.description)
        if request.sort.lstrip("-") == "assignee":
            relation = relation.outerjoin(agents, and_(
                agents.c.id == tasks.c.assigned_agent_id, agents.c.supervisor_user_id == request.owner,
                agents.c.enabled.is_(True), agents.c.deleted_at.is_(None),
            )).outerjoin(teams, and_(
                teams.c.id == tasks.c.assigned_team_id, teams.c.owner_user_id == request.owner,
                teams.c.deleted_at.is_(None),
            ))
            columns.extend([
                tasks.c.assigned_agent.label("agent"), tasks.c.assigned_team_id.label("team_id"),
                agents.c.display_name.label("agent_name"), teams.c.name.label("team_name"),
                snapshot["assignedWorkflowId"].as_string().label("workflow"),
            ])
        if request.project_id:
            scope = tasks.c.project_id == request.project_id
        elif request.computer_id:
            bound = bound_computer(snapshot)
            scope = and_(tasks.c.project_id.is_(None), or_(bound == request.computer_id, bound.is_(None)))
            columns.extend([snapshot["computerId"].as_string().label("computer"), *computer_list_columns(snapshot, bound)])
        statement = select(*columns).select_from(relation).where(
            tasks.c.owner_user_id == request.owner, tasks.c.deleted_at.is_(None), tasks.c.is_routine.is_(True), scope,
        ).order_by(tasks.c.updated_at.desc(), tasks.c.id.desc())

        with store_transaction(self.engine) as conn:
            rows: Sequence[AutomationRow] = list(conn.execute(statement).mappings())
            if request.computer_id:
                rows = with_effective_computers(conn, request.owner, rows)
            normalized = [dict(row, triggers=[
                trigger for trigger in triggers_of(dict(row)) if trigger.get("kind") in TRIGGER_KINDS
            ]) for row in rows]
            ids, result = automation_window(normalized, self._automation_states(conn, request) if rows else {}, request)
            records = {
                row["id"]: {**row["snapshot"], "eventCount": row["version"]}
                for row in conn.execute(select(tasks.c.id, tasks.c.snapshot, tasks.c.version).where(
                    tasks.c.id.in_(ids), tasks.c.owner_user_id == request.owner,
                    tasks.c.deleted_at.is_(None), tasks.c.is_routine.is_(True),
                )).mappings()
            } if ids else {}
        return [records[key] for key in ids if key in records], result

    def automation_record_context(self, owner: str, task: dict[str, Any]) -> dict[str, Any]:
        tasks = self.tasks
        parent_id = task.get("sourceRoutineId")
        if not task.get("isRoutine") and (not parent_id or sql.names_no_uuid_row(self.engine, parent_id)):
            return {}
        with store_transaction(self.engine) as conn:
            if task.get("isRoutine"):
                source = tasks.c.snapshot["sourceRoutineId"].as_string()
                live = self._automation_occurrence_statuses(owner).where(
                    source == task["id"], tasks.c.status.in_(RUNNING_OCCURRENCE_STATUSES),
                )
                return {"hasRunningOccurrence": bool(conn.scalar(select(live.exists())))}
            parent = conn.execute(select(tasks.c.id, tasks.c.title).where(
                tasks.c.id == parent_id, tasks.c.owner_user_id == owner,
                tasks.c.deleted_at.is_(None), tasks.c.is_routine.is_(True),
            )).mappings().first()
            return {"routineParent": dict(parent)} if parent else {}
