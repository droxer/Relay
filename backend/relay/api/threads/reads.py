from __future__ import annotations

from datetime import UTC, datetime
from typing import Any

from fastapi import APIRouter, HTTPException, Request

from ...core.computer_identity import computer_id as resolve_computer_id
from ...persistence.session.workspace_artifacts import (
    artifact_index_item,
    workspace_artifacts,
)
from ...security.actor import Actor
from ..actors import request_actor_or_sandbox
from ..deps import AppContext, AppContextDep
from .projections import (
    agent_for_workspace,
    agent_supervisor_user_id,
    ensure_sessions_managed_affinity,
    session_awaits_human,
    session_brief_item,
    session_uses_agent,
    task_brief_item,
    user_for_workspace_brief,
)

router = APIRouter()

ACTIVE_TASK_STATUSES = frozenset(
    {"assigned", "running", "waiting_for_human", "review", "blocked"}
)
ACTIVE_SESSION_STATUSES = frozenset({"running", "waiting_for_human"})


@router.get("/threads")
def list_sessions(request: Request, ctx: AppContextDep) -> dict[str, Any]:
    actor = request_actor_or_sandbox(request, ctx.auth_store, ctx.registry)
    if request.query_params.get("view") == "summary":
        try:
            requested_limit = int(request.query_params.get("limit") or "100")
        except ValueError as error:
            raise HTTPException(400, "limit must be an integer.") from error
        summaries = ctx.session_store.list_session_summaries(
            owner_user_id=None if actor["isAdmin"] else actor["userId"],
            limit=min(max(1, requested_limit), 200),
        )
        sessions = ensure_sessions_managed_affinity(ctx, summaries)
        sessions = ctx.execution_lifecycle.annotate(sessions)
        return {"sessions": [session_brief_item(session) for session in sessions]}
    visible = [
        session
        for session in ctx.session_store.list_sessions()
        if actor["isAdmin"] or session.get("ownerUserId") == actor["userId"]
    ]
    sessions = ensure_sessions_managed_affinity(ctx, visible)
    sessions = ctx.execution_lifecycle.annotate(sessions)
    return {"sessions": sessions}


ARTIFACT_INDEX_DEFAULT_LIMIT = 200
ARTIFACT_INDEX_MAX_LIMIT = 1000


def artifact_index_limit(raw: str | None) -> int:
    if raw is None or not raw.strip():
        return ARTIFACT_INDEX_DEFAULT_LIMIT
    try:
        value = int(raw)
    except ValueError:
        raise HTTPException(400, "limit must be an integer.") from None
    if value < 1:
        raise HTTPException(400, "limit must be at least 1.")
    return min(value, ARTIFACT_INDEX_MAX_LIMIT)


@router.get("/artifacts")
def list_artifacts(request: Request, ctx: AppContextDep) -> dict[str, Any]:
    actor = request_actor_or_sandbox(request, ctx.auth_store, ctx.registry)
    requested_user = request.query_params.get("userId")
    if (
        requested_user
        and not actor["isAdmin"]
        and requested_user != actor["userId"]
    ):
        raise HTTPException(403, "Cannot list artifacts for another user.")
    workspace_path = request.query_params.get("workspacePath")
    limit = artifact_index_limit(request.query_params.get("limit"))
    if hasattr(ctx.session_store, "list_artifact_summaries"):
        return {
            "artifacts": ctx.session_store.list_artifact_summaries(
                owner_user_id=requested_user
                or (None if actor["isAdmin"] else actor["userId"]),
                workspace_path=workspace_path,
                limit=limit,
            )
        }
    artifacts: list[dict[str, Any]] = []
    for session in ctx.session_store.list_sessions():
        owner = session.get("ownerUserId")
        if not actor["isAdmin"] and owner != actor["userId"]:
            continue
        if requested_user and owner != requested_user:
            continue
        if workspace_path and session.get("workspacePath") != workspace_path:
            continue
        for artifact in workspace_artifacts(session):
            artifacts.append(artifact_index_item(session, artifact))
    ordered = sorted(
        artifacts, key=lambda item: item.get("createdAt") or "", reverse=True
    )
    return {"artifacts": ordered[:limit]}


@router.get("/workspace/brief")
def workspace_brief(request: Request, ctx: AppContextDep) -> dict[str, Any]:
    actor = request_actor_or_sandbox(request, ctx.auth_store, ctx.registry)
    agent, team, project, user_id = _workspace_scope(ctx, actor, request)
    sessions = [
        session
        for session in ctx.session_store.list_session_snapshots(
            owner_user_id=user_id,
            project_id=project["id"] if project else None,
        )
        if (not agent or session_uses_agent(session, agent["id"]))
        and (not team or session.get("teamId") == team["id"])
    ]
    sessions = ensure_sessions_managed_affinity(ctx, sessions)
    scoped_session_ids = (
        {session["id"] for session in sessions} if team or project else set()
    )
    nodes = _workspace_nodes(ctx, agent, team, project, user_id, scoped_session_ids)
    active_runs = [
        run
        for node in nodes
        for run in node.get("activeRuns", [])
        if (not agent or run.get("logicalAgentId") == agent["id"])
        and (not team or run.get("sessionId") in scoped_session_ids)
        and (not project or run.get("sessionId") in scoped_session_ids)
    ]
    tasks = [
        task
        for task in ctx.task_store.list_task_summaries(user_id=user_id)
        if (not agent or task.get("assignedAgentId") == agent["id"])
        and (not team or task.get("assignedTeamId") == team["id"])
        and (not project or task.get("projectId") == project["id"])
    ]
    return {
        "userId": user_id,
        **({"agentId": agent["id"]} if agent else {}),
        **({"teamId": team["id"]} if team else {}),
        **({"projectId": project["id"]} if project else {}),
        **_workspace_brief_lists(nodes, active_runs, sessions, tasks),
        "generatedAt": datetime.now(UTC).isoformat().replace("+00:00", "Z"),
    }


def _workspace_scope(
    ctx: AppContext, actor: Actor, request: Request
) -> tuple[dict[str, Any] | None, dict[str, Any] | None, dict[str, Any] | None, str]:
    """The agent, team, or project a brief is scoped to, and whose work it reads."""
    requested_team_id = (request.query_params.get("teamId") or "").strip()
    requested_agent_id = (request.query_params.get("agentId") or "").strip()
    requested_project_id = (request.query_params.get("projectId") or "").strip()
    selectors = [requested_agent_id, requested_team_id, requested_project_id]
    if len([value for value in selectors if value]) > 1:
        raise HTTPException(
            400, "agentId, teamId, and projectId are mutually exclusive."
        )
    team = ctx.team_store.get_team(requested_team_id) if requested_team_id else None
    if requested_team_id and (not team or team.get("deletedAt")):
        raise HTTPException(404, "Team not found.")
    if (
        team
        and not actor["isAdmin"]
        and team.get("ownerUserId") != actor["userId"]
    ):
        raise HTTPException(403, "Cannot read another user's team workspace.")

    project = (
        ctx.project_store.get_project(requested_project_id)
        if requested_project_id
        else None
    )
    if requested_project_id and not project:
        raise HTTPException(404, "Project not found.")
    if (
        project
        and not actor["isAdmin"]
        and project.get("ownerUserId") != actor["userId"]
    ):
        raise HTTPException(403, "Cannot read another user's project workspace.")

    agent = agent_for_workspace(ctx, actor, requested_agent_id)
    user_id = (
        project.get("ownerUserId")
        if project
        else team.get("ownerUserId")
        if team
        else agent_supervisor_user_id(agent)
        if agent
        else user_for_workspace_brief(actor, request.query_params.get("userId"))
    )
    if not user_id:
        raise HTTPException(404, "Agent owner not found.")
    return agent, team, project, user_id


def _workspace_nodes(
    ctx: AppContext,
    agent: dict[str, Any] | None,
    team: dict[str, Any] | None,
    project: dict[str, Any] | None,
    user_id: str,
    scoped_session_ids: set[str],
) -> list[dict[str, Any]]:
    placements: list[dict[str, Any]] | None = None
    if agent:
        placements = ctx.agent_placement_store.list_placements(agent_id=agent["id"])
    elif team:
        placements = [
            placement
            for agent_id in team.get("memberAgentIds", [])
            for placement in ctx.agent_placement_store.list_placements(
                agent_id=agent_id
            )
        ]
    nodes = []
    for node in ctx.registry.monitor_nodes():
        active_node_runs = node.get("activeRuns", [])
        has_authorized_run = (
            any(run.get("logicalAgentId") == agent["id"] for run in active_node_runs)
            if agent
            else any(
                run.get("sessionId") in scoped_session_ids for run in active_node_runs
            )
            if team or project
            else False
        )
        has_placement = placements is not None and any(
            placement.get("computerId") == resolve_computer_id(node)
            or (
                not placement.get("computerId")
                and placement.get("daemonNodeId") == node["id"]
            )
            for placement in placements
        )
        include_node = (
            resolve_computer_id(node) == project.get("computerId")
            if project
            else node.get("userId") == user_id
            if placements is None
            else has_placement or has_authorized_run
        )
        if include_node:
            nodes.append(node)
    return nodes


def _workspace_brief_lists(
    nodes: list[dict[str, Any]],
    active_runs: list[dict[str, Any]],
    sessions: list[dict[str, Any]],
    tasks: list[dict[str, Any]],
) -> dict[str, Any]:
    artifacts = [
        artifact_index_item(session, artifact)
        for session in sessions
        for artifact in workspace_artifacts(session)
    ]
    workspace_sessions = sorted(
        sessions, key=lambda item: item.get("updatedAt") or "", reverse=True
    )
    active_tasks = [
        task for task in tasks if task.get("status") in ACTIVE_TASK_STATUSES
    ]
    recent_artifacts = sorted(
        artifacts, key=lambda item: item.get("createdAt") or "", reverse=True
    )[:12]
    return {
        "nodes": nodes,
        "activeRuns": sorted(
            active_runs, key=lambda item: item.get("startedAt") or "", reverse=True
        ),
        "sessions": [session_brief_item(session) for session in workspace_sessions],
        "tasks": [
            task_brief_item(task)
            for task in sorted(
                active_tasks, key=lambda item: item.get("updatedAt") or "", reverse=True
            )[:10]
        ],
        "artifacts": recent_artifacts,
        "metrics": {
            "nodeCount": len(nodes),
            "activeRunCount": len(active_runs),
            "sessionCount": len(sessions),
            "activeSessionCount": len(
                [
                    session
                    for session in sessions
                    if session.get("status") in ACTIVE_SESSION_STATUSES
                    or session_awaits_human(session, tasks)
                ]
            ),
            "taskCount": len(tasks),
            "activeTaskCount": len(active_tasks),
            "artifactCount": len(artifacts),
        },
    }
