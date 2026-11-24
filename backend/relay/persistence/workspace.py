"""SQL scopes shared by Workspace previews and their totals."""

from typing import Any

from sqlalchemy import or_, select

from .tables.projects import projects
from .tables.sessions import agent_runs


def workspace_thread_scope(
    sessions: Any, owner: str, *, project_id: str | None = None,
    team_id: str | None = None, agent_id: str | None = None,
) -> list[Any]:
    filters = [sessions.c.owner_user_id == owner]
    if project_id is not None:
        filters.append(sessions.c.project_id == project_id)
    if team_id is not None:
        filters.append(sessions.c.snapshot["teamId"].as_string() == team_id)
    if agent_id is not None:
        joined = select(agent_runs.c.session_id).where(agent_runs.c.logical_agent_id == agent_id)
        filters.append(or_(sessions.c.snapshot["ownerAgentId"].as_string() == agent_id, sessions.c.id.in_(joined)))
    return filters


def workspace_task_scope(
    tasks: Any, owner: str, *, project_id: str | None = None,
    team_id: str | None = None, agent_id: str | None = None,
) -> list[Any]:
    filters = [
        tasks.c.owner_user_id == owner, tasks.c.deleted_at.is_(None),
        or_(tasks.c.project_id.is_(None), select(projects.c.id).where(projects.c.id == tasks.c.project_id).exists()),
    ]
    if project_id is not None:
        filters.append(tasks.c.project_id == project_id)
    if team_id is not None:
        filters.append(tasks.c.assigned_team_id == team_id)
    if agent_id is not None:
        filters.append(tasks.c.assigned_agent_id == agent_id)
    return filters
