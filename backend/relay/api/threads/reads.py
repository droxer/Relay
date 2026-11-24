from __future__ import annotations

import json
import os
from datetime import UTC, datetime
from typing import Any, TypedDict

from fastapi import APIRouter, HTTPException, Request, Response
from fastapi.responses import JSONResponse

from ...security.actor import Actor
from ..actors import request_actor, request_actor_or_sandbox
from ..conditional_get import CACHE_CONTROL, etag_matches, request_validator, weak_etag
from ..deps import AppContext, AppContextDep
from ..record_cursor import decode_record_cursor, encode_record_cursor
from .activity import ThreadListActivity, apply_thread_list_activity, read_thread_list_activity
from .projections import (
    agent_for_workspace,
    agent_supervisor_user_id,
    ensure_sessions_managed_affinity,
    session_brief_item,
    task_brief_item,
    user_for_workspace_brief,
)

router = APIRouter()

ACTIVE_TASK_STATUSES = frozenset(
    {"assigned", "queued", "running", "waiting_for_human", "review", "blocked"}
)
_SUMMARY_REPRESENTATION = ("thread-summary-v1", os.environ.get("RAILWAY_GIT_COMMIT_SHA"))


class WorkspaceScope(TypedDict):
    agent_id: str | None
    team_id: str | None
    project_id: str | None


def thread_list_position(
    request: Request, *, summary: bool = False,
) -> tuple[int, tuple[datetime, str] | None]:
    default, maximum = (100, 200) if summary else (25, 50)
    try:
        requested = int(request.query_params.get("limit") or str(default))
    except ValueError as error:
        raise HTTPException(400, "limit must be an integer.") from error
    cursor = request.query_params.get("cursor")
    return min(max(1, requested), maximum), decode_record_cursor(cursor) if cursor else None


@router.get("/threads", response_model=dict[str, Any])
def list_sessions(request: Request, ctx: AppContextDep) -> dict[str, Any] | Response:
    summary_view = request.query_params.get("view") == "summary"
    include_activity = summary_view and request.query_params.get("include") == "activity"
    # Task projections use the same credentials as GET /tasks.
    actor = (request_actor(request, ctx.auth_store) if include_activity
             else request_actor_or_sandbox(request, ctx.auth_store, ctx.registry))
    limit, before = thread_list_position(request, summary=summary_view)
    if summary_view:
        with ctx.session_store.summary_read_scope():
            stamp = ctx.session_store.summary_page_stamp(owner_user_id=actor["userId"], limit=limit, before=before)
            if stamp is not None:
                ids, revision = stamp
                activity = read_thread_list_activity(ctx, actor, ids, include_home_count=before is None) if include_activity else None
                activity_revision = (
                    [sorted(activity[0], key=lambda link: str(link["sessionId"])), sorted(activity[1]), activity[2]]
                    if activity is not None else None
                )
                etag = weak_etag(json.dumps(
                    [_SUMMARY_REPRESENTATION, actor["userId"], revision, activity_revision], default=str, sort_keys=True,
                ).encode())
                headers = {"ETag": etag.decode("ascii"), "Cache-Control": CACHE_CONTROL.decode("ascii")}
                if etag_matches(request_validator(request), etag):
                    return Response(status_code=304, headers=headers)
                payload = _session_summary_page(ctx, actor, limit, before, include_activity, activity)
                return JSONResponse(payload, headers=headers)
        return _session_summary_page(ctx, actor, limit, before, include_activity)
    visible, position = ctx.session_store.list_session_record_page(
        owner_user_id=actor["userId"], limit=limit, before=before,
    )
    sessions = ensure_sessions_managed_affinity(ctx, visible)
    sessions = ctx.execution_lifecycle.annotate(sessions)
    return {"sessions": sessions, "nextCursor": encode_record_cursor(position) if position else None}


def _session_summary_page(
    ctx: AppContext, actor: Actor, limit: int, before: tuple[datetime, str] | None,
    include_activity: bool, activity: ThreadListActivity | None = None,
) -> dict[str, Any]:
    summaries, next_position = ctx.session_store.list_session_summary_page(
        owner_user_id=actor["userId"], limit=limit, before=before,
    )
    sessions = ctx.execution_lifecycle.annotate(ensure_sessions_managed_affinity(ctx, summaries))
    rows = [session_brief_item(session) for session in sessions]
    if include_activity and activity is None:
        activity = read_thread_list_activity(ctx, actor, [row["id"] for row in rows], include_home_count=before is None)
    return {
        "sessions": rows,
        "nextCursor": encode_record_cursor(next_position) if next_position else None,
        **(apply_thread_list_activity(rows, activity) if activity is not None else {}),
    }


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
        and requested_user != actor["userId"]
    ):
        raise HTTPException(403, "Cannot list artifacts for another user.")
    workspace_path = request.query_params.get("workspacePath")
    limit = artifact_index_limit(request.query_params.get("limit"))
    return {
        "artifacts": ctx.session_store.list_artifact_summaries(
            owner_user_id=requested_user or actor["userId"], workspace_path=workspace_path, limit=limit,
        )
    }



@router.get("/workspace/brief", response_model=dict[str, Any])
def workspace_brief(request: Request, ctx: AppContextDep) -> dict[str, Any] | Response:
    actor = request_actor_or_sandbox(request, ctx.auth_store, ctx.registry)
    agent, team, project, user_id = _workspace_scope(ctx, actor, request)
    if request.query_params.get("view") == "activity":
        payload = _workspace_activity(ctx, user_id, agent, team, project, request)
        response = JSONResponse(payload)
        etag = weak_etag(bytes(response.body))
        headers = {"ETag": etag.decode("ascii"), "Cache-Control": CACHE_CONTROL.decode("ascii")}
        if etag_matches(request_validator(request), etag):
            return Response(status_code=304, headers=headers)
        response.headers.update(headers)
        return response
    scope: WorkspaceScope = {
        "agent_id": agent["id"] if agent else None,
        "team_id": team["id"] if team else None,
        "project_id": project["id"] if project else None,
    }
    limit, before = _workspace_thread_page(request)
    sessions, position = ctx.session_store.list_session_summary_page(
        owner_user_id=user_id, limit=limit, before=before, **scope,
    )
    page = {
        "sessions": [session_brief_item(session) for session in ensure_sessions_managed_affinity(ctx, sessions)],
        "nextThreadCursor": encode_record_cursor(position) if position else None,
    }
    artifact_scope = ctx.session_store.list_artifact_summaries(owner_user_id=user_id, limit=12, **scope)
    running = ctx.registry.daemon_store.list_workspace_active_runs(
        user_id, computer_id=project.get("computerId") if project else None, include_node=True, **scope,
    )
    nodes = _workspace_nodes(ctx, agent, team, project, user_id, {run["nodeId"] for run in running})
    runs = {run["runId"] for run in running}
    active_runs = sorted(
        (run for node in nodes for run in node.get("activeRuns", []) if run["runId"] in runs),
        key=lambda run: run.get("startedAt") or "", reverse=True,
    )
    tasks = ctx.task_store.list_task_summaries(
        user_id=user_id, limit=10, project_id=scope["project_id"],
        assigned_agent_id=scope["agent_id"], assigned_team_id=scope["team_id"], statuses=ACTIVE_TASK_STATUSES,
    )
    task_count, active_task_count = ctx.task_store.workspace_task_counts(user_id, statuses=ACTIVE_TASK_STATUSES, **scope)
    session_count, active_session_count = ctx.session_store.workspace_thread_counts(user_id, **scope)
    return {
        "userId": user_id,
        **({"agentId": agent["id"]} if agent else {}),
        **({"teamId": team["id"]} if team else {}),
        **({"projectId": project["id"]} if project else {}),
        **page,
        "nodes": nodes,
        "activeRuns": active_runs,
        "tasks": [task_brief_item(task) for task in tasks],
        "artifacts": artifact_scope,
        "metrics": {
            "nodeCount": len(nodes),
            "activeRunCount": len(active_runs),
            "sessionCount": session_count,
            "activeSessionCount": active_session_count,
            "taskCount": task_count,
            "activeTaskCount": active_task_count,
            "artifactCount": ctx.session_store.workspace_artifact_count(user_id, **scope),
        },
        "generatedAt": datetime.now(UTC).isoformat().replace("+00:00", "Z"),
    }


def _workspace_thread_page(request: Request) -> tuple[int, tuple[datetime, str] | None]:
    raw_limit = request.query_params.get("threadLimit", "20")
    cursor = request.query_params.get("threadCursor")
    try:
        limit = min(max(1, int(raw_limit)), 100)
    except ValueError as error:
        raise HTTPException(400, "threadLimit must be an integer.") from error
    return limit, decode_record_cursor(cursor) if cursor else None


def _workspace_activity(
    ctx: AppContext, user_id: str,
    agent: dict[str, Any] | None, team: dict[str, Any] | None, project: dict[str, Any] | None,
    request: Request,
) -> dict[str, Any]:
    agent_id = agent["id"] if agent else None
    team_id = team["id"] if team else None
    project_id = project["id"] if project else None
    limit, before = _workspace_thread_page(request)
    sessions, next_position = ctx.session_store.list_workspace_threads(
        owner_user_id=user_id, project_id=project_id, team_id=team_id, agent_id=agent_id,
        limit=limit, before=before,
    )
    page: dict[str, Any] = {"sessions": sessions}
    if next_position or before or "threadLimit" in request.query_params:
        page["nextThreadCursor"] = encode_record_cursor(next_position) if next_position else None
    if before:
        return page
    runs = ctx.registry.daemon_store.list_workspace_active_runs(
        user_id, project_id=project_id, team_id=team_id, agent_id=agent_id,
        computer_id=project.get("computerId") if project else None,
    )
    tasks = ctx.task_store.list_task_summaries(
        user_id=user_id, limit=10, project_id=project_id,
        assigned_agent_id=agent_id, assigned_team_id=team_id, statuses=ACTIVE_TASK_STATUSES,
    )
    return {
        **page,
        "activeRuns": runs,
        "tasks": [task_brief_item(task) for task in tasks],
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
    active_node_ids: set[str],
) -> list[dict[str, Any]]:
    if project:
        return ctx.registry.monitor_nodes_for_computers({project["computerId"]})
    if not agent and not team:
        return ctx.registry.monitor_nodes_for_user(user_id)
    agents = {agent["id"]} if agent else set((team or {}).get("memberAgentIds", []))
    placements = ctx.agent_placement_store.list_placements(agent_ids=agents)
    computers = {placement["computerId"] for placement in placements if placement.get("computerId")}
    legacy_ids = {placement["daemonNodeId"] for placement in placements if not placement.get("computerId")}
    return ctx.registry.monitor_nodes_for_computers(computers, legacy_node_ids=legacy_ids | active_node_ids)
