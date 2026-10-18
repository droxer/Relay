from __future__ import annotations

import base64
import json
import time
from collections.abc import AsyncIterator
from dataclasses import dataclass
from datetime import datetime, UTC
from typing import Any, Protocol, cast
from urllib.parse import quote

from fastapi import APIRouter, HTTPException, Request, Response
from fastapi.responses import PlainTextResponse, StreamingResponse
from loguru import logger
from starlette.concurrency import run_in_threadpool

from ..collaboration.awaiting import task_awaiting
from ..core.computer_identity import computer_id as resolve_computer_id
from ..core.ids import new_database_id
from ..core.models import AGENT_NAMES
from ..core.permission_requests import PERMISSION_DECISIONS, PERMISSION_NOTE_MAX_CHARS
from ..persistence.stores import valid_agent
from ..services.event_notifier import session_event_key
from ..services.session_deletion import delete_thread
from ..services.team_dispatch import (
    TeamDispatchError,
    task_thread_assignments,
    task_thread_ownership,
)
from ..services.task_workspace import recorded_session_workspace
from ..sessions.controller import SessionArchivedError, SessionController, SessionRunInFlightError
from ..sessions.task_scope import thread_task_scope
from .deps import AppContext, AppContextDep
from .actors import (
    get_session_for_actor,
    get_session_header_for_actor,
    get_task_for_actor,
    owner_user_id_for_create,
    request_actor,
    request_actor_or_sandbox,
)
from ..persistence.workspace_artifacts import artifact_index_item, is_workspace_artifact, workspace_artifacts
from .bodies import JsonBodyDep, assignment_list, role_name, string_field
from .schemas import ThreadCreateBody, ThreadCreateBodyDep, openapi_body
from .project_helpers import (
    ensure_project_node_matches,
    project_for_owner,
    project_session_fields,
)
from .workspace_transport import (
    dispatch_workspace_command,
    raise_workspace_error,
    workspace_binding_command,
    workspace_binding_target,
    workspace_path,
)
from ..persistence.daemon.rules import TERMINAL_CLAIM_EXPIRES_STATE_KEY, TERMINAL_CLAIM_ID_STATE_KEY
from ..core.settings import StreamSettings
from ..security.actor import Actor

router = APIRouter()


class _RunRequestRecovery(Protocol):
    """Run-request reads and writes both daemon stores implement but the
    ``DaemonStore`` protocol does not yet declare."""

    def active_run_request_for_session_any_node(
        self, session_id: str
    ) -> dict[str, Any] | None: ...

    def update_run_request_if_claimed(
        self, request_id: str, claim_key: str, claim_id: str, patch: dict[str, Any]
    ) -> dict[str, Any] | None: ...


ACTIVE_TASK_STATUSES = frozenset(
    {"assigned", "running", "waiting_for_human", "review", "blocked"}
)
ACTIVE_SESSION_STATUSES = frozenset({"running", "waiting_for_human"})


def session_awaits_human(
    session: dict[str, Any], tasks: list[dict[str, Any]] | None = None
) -> bool:
    """Whether the thread is parked on its human — the web's prompt rule.

    A rejected turn says so in its status. A round that stopped closes its
    session `completed` and parks its task, so a completed thread waits when a
    waiting task names it (`awaiting.sessionId`). A thread with no task, or a
    legacy one whose task the caller does not hold, waits when its last
    round was blocked; a held task that waits elsewhere, or no longer waits,
    means that blocked outcome is history.
    """
    if session.get("status") == "waiting_for_human":
        return True
    if session.get("status") != "completed":
        return False
    tasks = tasks or []
    if any(
        (task_awaiting(task) or {}).get("sessionId") == session.get("id")
        for task in tasks
    ):
        return True
    if session.get("workOutcome") != "blocked":
        return False
    scope = next(
        (
            item.get("workScope")
            for item in session.get("collaborationRounds") or []
            if item.get("roundId") == session.get("activeRoundId")
        ),
        None,
    )
    if isinstance(scope, dict) and scope.get("kind") == "task":
        return not any(task.get("id") == scope.get("taskId") for task in tasks)
    return True


def session_artifact(
    session: dict[str, Any], artifact_id: str
) -> dict[str, Any] | None:
    return next(
        (
            artifact
            for artifact in session.get("artifacts", [])
            if artifact.get("id") == artifact_id
        ),
        None,
    )


def session_brief_item(session: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": session["id"],
        "execution": session.get("execution"),
        "deletionRequestedAt": session.get("deletionRequestedAt"),
        "title": session.get("title"),
        "taskGoal": session.get("taskGoal"),
        "status": session.get("status"),
        "workOutcome": session.get("workOutcome"),
        "phase": session.get("phase"),
        "daemonNodeId": session.get("daemonNodeId"),
        "managedNodeId": session.get("managedNodeId"),
        "workspacePath": session.get("workspacePath"),
        "ownerUserId": session.get("ownerUserId"),
        "ownerAgentId": session.get("ownerAgentId"),
        "teamId": session.get("teamId"),
        "projectId": session.get("projectId"),
        "workspaceLayout": session.get("workspaceLayout"),
        "workspaceSubpath": session.get("workspaceSubpath"),
        "computerId": session.get("computerId"),
        "currentAgent": session.get("currentAgent"),
        "pendingDecision": session.get("pendingDecision"),
        "permissionRequests": session.get("permissionRequests") or [],
        "archived": session.get("archived", False),
        "artifactCount": session.get(
            "artifactCount", len(workspace_artifacts(session))
        ),
        "runCount": session.get("runCount", len(session.get("agentRuns", []))),
        "eventCount": session.get("eventCount", len(session.get("events", []))),
        "updatedAt": session.get("updatedAt"),
        "createdAt": session.get("createdAt"),
    }


def task_brief_item(task: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": task["id"],
        "title": task.get("title"),
        "status": task.get("status"),
        "priority": task.get("priority"),
        "ownerUserId": task.get("ownerUserId"),
        "projectId": task.get("projectId"),
        "assigneeUserId": task.get("assigneeUserId"),
        "assignedAgent": task.get("assignedAgent"),
        "assignedAgentId": task.get("assignedAgentId"),
        "assignedTeamId": task.get("assignedTeamId"),
        "dueDate": task.get("dueDate"),
        "isRoutine": task.get("isRoutine", False),
        "routineTriggers": task.get("routineTriggers", []) if task.get("isRoutine") else [],
        "routineState": task.get("routineState") if task.get("isRoutine") else None,
        "routineNextRunAt": task.get("routineNextRunAt"),
        "linkedSessionIds": task.get("linkedSessionIds", []),
        # Where a waiting task's answer belongs: not necessarily its newest link.
        "awaiting": task_awaiting(task),
        "updatedAt": task.get("updatedAt"),
        "createdAt": task.get("createdAt"),
    }


def user_for_workspace_brief(
    actor: Actor, requested_user: str | None
) -> str:
    requested = (
        requested_user.strip() if isinstance(requested_user, str) else ""
    )
    if requested and actor["isAdmin"]:
        return requested
    if requested and requested != actor["userId"]:
        raise HTTPException(403, "Cannot read another user's workspace.")
    return actor["userId"]


def agent_supervisor_user_id(agent: dict[str, Any]) -> str | None:
    """Return an agent's owner across current and legacy agent snapshots."""
    owner = agent.get("supervisorUserId") or agent.get("userId")
    return owner if isinstance(owner, str) and owner else None


def agent_for_workspace(
    ctx: AppContext, actor: Actor, requested_agent: str | None
) -> dict[str, Any] | None:
    agent_id = requested_agent.strip() if isinstance(requested_agent, str) else ""
    if not agent_id:
        return None
    agent = ctx.agent_store.get_agent(agent_id)
    if not agent or agent.get("deletedAt"):
        raise HTTPException(404, "Agent not found.")
    if (
        not actor["isAdmin"]
        and agent_supervisor_user_id(agent) != actor["userId"]
    ):
        raise HTTPException(403, "Cannot read another user's agent workspace.")
    return agent


def session_uses_agent(session: dict[str, Any], agent_id: str) -> bool:
    return session.get("ownerAgentId") == agent_id or any(
        run.get("logicalAgentId") == agent_id for run in session.get("agentRuns", [])
    )


def ensure_sessions_managed_affinity(
    ctx: AppContext, sessions: list[dict[str, Any]]
) -> list[dict[str, Any]]:
    """Derive a legacy session's ``computerId`` for a read response only.

    A session that already recorded its own ``managedNodeId`` derives its
    identity from that directly — it never round-trips through daemon
    registration history. Only a session with neither field falls back to
    ``historical_managed_node_ids``. Preferring the session's own record
    This helper never appends an event. Explicit dispatch paths persist the
    same derivation; GET/list/workspace reads must remain side-effect free.
    """
    unresolved_runtime_ids = {
        session["daemonNodeId"]
        for session in sessions
        if not session.get("computerId")
        and not session.get("managedNodeId")
        and isinstance(session.get("daemonNodeId"), str)
    }
    identities = (
        ctx.registry.daemon_store.historical_managed_node_ids(unresolved_runtime_ids)
        if unresolved_runtime_ids
        else {}
    )
    resolved: list[dict[str, Any]] = []
    for session in sessions:
        if session.get("computerId"):
            resolved.append(session)
        elif session.get("managedNodeId"):
            resolved.append(
                {**session, "computerId": f"managed:{session['managedNodeId']}"}
            )
        elif session.get("daemonNodeId") in identities:
            managed_node_id = identities[session["daemonNodeId"]]
            resolved.append(
                {
                    **session,
                    "managedNodeId": managed_node_id,
                    "computerId": f"managed:{managed_node_id}",
                }
            )
        else:
            resolved.append(session)
    return resolved


def ensure_session_managed_affinity(
    ctx: AppContext, session: dict[str, Any]
) -> dict[str, Any]:
    return ensure_sessions_managed_affinity(ctx, [session])[0]


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


@router.post("/threads", status_code=201, openapi_extra=openapi_body(ThreadCreateBody))
def create_session(
    request: Request, ctx: AppContextDep, *, _request_body: ThreadCreateBodyDep
) -> dict[str, Any]:
    actor = request_actor_or_sandbox(request, ctx.auth_store, ctx.registry)
    body = _request_body
    task_goal = body.task_goal
    if not task_goal:
        raise HTTPException(400, "taskGoal is required.")
    assignments = assignment_list(body.assignments)
    owner_agent_id = next(
        (
            assignment.get("agentId")
            for assignment in assignments
            if assignment.get("agentId")
        ),
        None,
    )
    workspace_path = body.workspace_path or "/workspace"
    daemon_node_id = body.node_id()
    managed_node_id = None
    session_computer_id = None
    task_id = body.task_id
    task = get_task_for_actor(ctx.task_store, task_id, actor) if task_id else None
    requested_project_id = body.project_id or None
    task_project_id = task.get("projectId") if task else None
    if requested_project_id and task_project_id and requested_project_id != task_project_id:
        raise HTTPException(400, "thread_project_task_mismatch")
    project_id = task_project_id or requested_project_id
    if project_id and body.is_set("assignments"):
        raise HTTPException(400, "project_assignment_override_unsupported")
    owner = owner_user_id_for_create(actor, body.as_dict())
    thread_ownership = {
        "owner_user_id": owner,
        **({"owner_agent_id": owner_agent_id} if owner_agent_id else {}),
    }
    if task:
        thread_ownership, assignments, owner = _task_thread_ownership(
            ctx, task, body, assignments, owner
        )
    node = _selected_thread_node(ctx, daemon_node_id, owner) if daemon_node_id else None
    if node:
        managed_node_id = node.get("managedNodeId")
        session_computer_id = resolve_computer_id(node)
    project = project_for_owner(ctx, project_id, owner, require_enabled=True) if project_id and owner else None
    project_fields: dict[str, Any] = {}
    if project:
        ensure_project_node_matches(project, node)
        project_fields = project_session_fields(ctx, project)
        workspace_path = project_fields.pop("workspace_path")
        session_computer_id = project_fields.pop("computer_id")
    controller = SessionController(
        ctx.session_store,
        task_store=ctx.task_store,
        task_id=task_id,
        workspace_path=workspace_path,
        daemon_node_id=daemon_node_id,
        managed_node_id=managed_node_id,
        computer_id=session_computer_id,
        **project_fields,
        **thread_ownership,
    )
    session = controller.create_session(
        task_goal,
        list(
            dict.fromkeys(
                ["human", *(assignment["agent"] for assignment in assignments)]
            )
        ),
    )
    if assignments:
        controller.assign_session(session["id"], assignments)
    logger.info(
        "Session created",
        session_id=session["id"],
        workspace_path=workspace_path,
        owner=owner,
    )
    return ctx.session_store.get_session(session["id"])


def _task_thread_ownership(
    ctx: AppContext,
    task: dict[str, Any],
    body: ThreadCreateBody,
    assignments: list[dict[str, Any]],
    owner: str,
) -> tuple[dict[str, Any], list[dict[str, Any]], str]:
    """A task thread's ownership and assignments come from the task."""
    try:
        thread_ownership = task_thread_ownership(
            task, team_store=ctx.team_store, agent_store=ctx.agent_store
        )
        assignments = task_thread_assignments(
            task,
            assignments,
            team_store=ctx.team_store,
            agent_store=ctx.agent_store,
        )
    except TeamDispatchError as error:
        raise HTTPException(409, error.code) from error
    expected_owner = thread_ownership.get("owner_user_id")
    requested_owner = body.owner_user_id or body.user_id
    if requested_owner and requested_owner != expected_owner:
        raise HTTPException(
            403, "Session owner must match the linked task assignee."
        )
    owner = expected_owner or owner
    if owner and "owner_user_id" not in thread_ownership:
        thread_ownership = {**thread_ownership, "owner_user_id": owner}
    return thread_ownership, assignments, owner


def _selected_thread_node(
    ctx: AppContext, daemon_node_id: str, owner: str
) -> dict[str, Any]:
    node = next(
        (
            item
            for item in ctx.registry.monitor_nodes()
            if item.get("id") == daemon_node_id
        ),
        None,
    )
    if not node or not node.get("online") or node.get("stale"):
        raise HTTPException(
            409,
            {
                "code": "node_offline",
                "message": "The selected computer is not available.",
            },
        )
    if owner and node.get("userId") != owner:
        raise HTTPException(
            403, "The selected computer belongs to another user."
        )
    return node


@router.get("/threads/{session_id}")
def get_session(
    session_id: str, request: Request, ctx: AppContextDep
) -> dict[str, Any]:
    actor = request_actor_or_sandbox(request, ctx.auth_store, ctx.registry)
    session = ensure_session_managed_affinity(
        ctx, get_session_for_actor(ctx.session_store, session_id, actor)
    )
    return {**session, "execution": ctx.execution_lifecycle.status(session)}


@router.get("/threads/{session_id}/execution")
def get_execution_status(session_id: str, request: Request, ctx: AppContextDep) -> dict[str, Any]:
    actor = request_actor(request, ctx.auth_store)
    session = get_session_for_actor(ctx.session_store, session_id, actor)
    return ctx.execution_lifecycle.status(session)


@router.post("/threads/{session_id}/execution/recovery")
def retry_execution_recovery(session_id: str, request: Request, ctx: AppContextDep) -> dict[str, Any]:
    actor = request_actor(request, ctx.auth_store)
    session = get_session_for_actor(ctx.session_store, session_id, actor)

    daemon_store = cast(_RunRequestRecovery, ctx.daemon_store)
    with ctx.registry.dispatch_lock:
        run = daemon_store.active_run_request_for_session_any_node(session_id)
        state = dict((run or {}).get("state") or {})
        if run and run.get("status") == "finalizing" and state.get("_relay_recovery_required"):
            claim = state.get(TERMINAL_CLAIM_ID_STATE_KEY)
            if claim:
                state.pop("_relay_recovery_required", None)
                state.pop("_relay_finalization_retry_at", None)
                state["_relay_finalization_attempts"] = 0
                state[TERMINAL_CLAIM_EXPIRES_STATE_KEY] = datetime.now(UTC).isoformat()
                daemon_store.update_run_request_if_claimed(run["id"], TERMINAL_CLAIM_ID_STATE_KEY, claim, {"state": state})
    return ctx.execution_lifecycle.status(session)


@router.post("/threads/{session_id}/execution/reconcile")
def reconcile_execution(session_id: str, request: Request, ctx: AppContextDep) -> dict[str, Any]:
    """Release a blocked execution on a person's word that the agent is gone.

    The retry above repairs a save that failed after the daemon reported exit.
    This one covers the case where the report is never coming: without it a
    thread whose computer died can never be deleted, and the node cannot be
    deleted either while its stuck request counts as active work.
    """
    actor = request_actor(request, ctx.auth_store)
    get_session_for_actor(ctx.session_store, session_id, actor)
    status = ctx.execution_lifecycle.reconcile(session_id, actor["userId"])
    if status is None:
        raise HTTPException(
            409,
            "Only an execution Relay has given up on can be reported gone.",
        )
    return status


@router.patch("/threads/{session_id}")
def update_session(
    session_id: str, request: Request, ctx: AppContextDep, *, _request_body: JsonBodyDep
) -> dict[str, Any]:
    actor = request_actor_or_sandbox(request, ctx.auth_store, ctx.registry)
    get_session_for_actor(ctx.session_store, session_id, actor)
    body = _request_body
    unknown = set(body) - {"title", "archived"}
    if unknown or not body:
        fields = ", ".join(sorted(unknown)) if unknown else "none"
        raise HTTPException(400, f"Unsupported thread field(s): {fields}.")
    controller = SessionController(
        ctx.session_store,
        task_store=ctx.task_store,
        owner_user_id=actor["userId"],
    )
    result = ctx.session_store.get_session(session_id)
    if "title" in body:
        title = string_field(body, "title").strip()
        if not title:
            raise HTTPException(400, "title is required.")
        if len(title) > 200:
            raise HTTPException(400, "title must be 200 characters or fewer.")
        result = controller.rename_session(session_id, title)
    if "archived" in body:
        if body["archived"] is not True:
            raise HTTPException(400, "archived currently supports only true.")
        result = controller.archive_session(session_id)
    return result


@router.post("/threads/{session_id}/cancellations", status_code=202)
def cancel_session_run(
    session_id: str, request: Request, ctx: AppContextDep, *, _request_body: JsonBodyDep
) -> dict[str, Any]:
    actor = request_actor_or_sandbox(request, ctx.auth_store, ctx.registry)
    session = get_session_for_actor(ctx.session_store, session_id, actor)
    body = _request_body
    reason = string_field(body, "reason") or "Cancelled by user."
    node = next(
        (
            item
            for item in ctx.registry.monitor_nodes()
            if any(
                run.get("sessionId") == session_id for run in item.get("activeRuns", [])
            )
        ),
        None,
    )
    run_request = ctx.registry.daemon_store.active_run_request_for_session_any_node(
        session_id
    )
    node_id = node["id"] if node else run_request.get("nodeId") if run_request else None
    # Resolved before cancelling: an undelivered request stops being active,
    # and its task must still be released or the scheduler starts it again.
    task_id, task_owner = thread_task_scope(
        session, run_request, ctx.task_store, ctx.registry.daemon_store
    )
    if node_id:
        cancelled = ctx.backend.cancel_run(
            node_id,
            session_id,
            reason,
            actor_user_id=actor["userId"],
            actor_is_admin=bool(actor.get("isAdmin")),
        )
        if cancelled is not None:
            return cancelled
        # The node had no cancellable run — it finished moments ago, or its run
        # request is parked in a state list_active_runs never reports, such as
        # finalizing. Cancel the thread itself rather than failing: Stop must
        # never be a dead end that leaves a thread stuck running forever.
    if session.get("status") in ("completed", "failed", "cancelled"):
        return session
    return SessionController(
        ctx.session_store,
        task_store=ctx.task_store,
        task_id=task_id,
        task_execution_owner=task_owner,
        owner_user_id=actor["userId"],
    ).cancel_session(session_id, reason, actor_user_id=actor["userId"])


@router.post("/threads/{session_id}/assignments")
def assign_session(
    session_id: str, request: Request, ctx: AppContextDep, *, _request_body: JsonBodyDep
) -> dict[str, Any]:
    actor = request_actor_or_sandbox(request, ctx.auth_store, ctx.registry)
    get_session_for_actor(ctx.session_store, session_id, actor)
    body = _request_body
    assignments = assignment_list(body.get("assignments"))
    if not assignments:
        raise HTTPException(400, "assignments must include at least one agent.")
    controller = SessionController(
        ctx.session_store,
        task_store=ctx.task_store,
        owner_user_id=actor["userId"],
    )
    try:
        controller.assign_session(session_id, assignments)
    except SessionArchivedError:
        raise HTTPException(409, "Session is archived.") from None
    except SessionRunInFlightError:
        raise HTTPException(409, "Session has a run in flight.") from None
    return ctx.session_store.get_session(session_id)


@router.delete("/threads/{session_id}", status_code=204)
def delete_session(
    session_id: str, request: Request, ctx: AppContextDep
) -> Response:
    actor = request_actor(request, ctx.auth_store)
    get_session_for_actor(ctx.session_store, session_id, actor)
    stop = request.query_params.get("stop", "false")
    if stop not in ("true", "false"):
        raise HTTPException(400, "stop must be true or false.")
    if stop == "true":
        from fastapi.responses import JSONResponse
        status = ctx.execution_lifecycle.request_delete(session_id, actor["userId"])
        return JSONResponse(status, status_code=202) if status else Response(status_code=204)
    try:
        delete_thread(
            ctx,
            session_id,
            execution_lifecycle=ctx.execution_lifecycle,
            deleted_by=actor["userId"],
            reload=lambda: get_session_for_actor(ctx.session_store, session_id, actor),
        )
    except SessionRunInFlightError:
        raise HTTPException(409, "Session has a run in flight.") from None
    return Response(status_code=204)


def _assert_rejectable(session: dict[str, Any], ctx: Any) -> None:
    """Refuse a reject that would leave the thread and its task disagreeing.

    A reject parks the thread for feedback. While a run is in flight there is
    no finished turn to reject, and while the round's task awaits review the
    task's own review is where changes are requested — a thread reject would
    leave that task in review with nothing to resume it.
    """
    if session.get("status") == "running" or (
        ctx.registry.daemon_store.active_run_request_for_session_any_node(session["id"])
    ):
        raise HTTPException(409, "session_run_in_flight")
    active_round: dict[str, Any] = next(
        (
            item
            for item in session.get("collaborationRounds", [])
            if item.get("roundId") == session.get("activeRoundId")
        ),
        {},
    )
    scope = active_round.get("workScope") or {}
    if scope.get("kind") != "task" or not scope.get("taskId"):
        return
    try:
        task = ctx.task_store.get_task(scope["taskId"])
    except (KeyError, FileNotFoundError):
        return
    if task.get("status") == "review" and not task.get("deletedAt"):
        raise HTTPException(409, "task_review_pending")


@router.post("/threads/{session_id}/decisions")
def decision(
    session_id: str, request: Request, ctx: AppContextDep, *, _request_body: JsonBodyDep
) -> dict[str, Any]:
    # The sandbox credential here is the browser-minted UI token, which acts as
    # its user; the daemon (and every agent) holds only the node token,
    # which never authenticates as a person.
    actor = request_actor_or_sandbox(request, ctx.auth_store, ctx.registry)
    session = get_session_for_actor(ctx.session_store, session_id, actor)
    body = _request_body
    kind = body.get("kind")
    if kind in ("rerun", "handoff"):
        # These name the next turn, and this route dispatches nothing; recording
        # one here would mark the thread running with no run behind it.
        raise HTTPException(
            400, f"{kind} dispatches an agent; send it through POST /agent-runs."
        )
    if kind not in ("approve", "reject", "cancel", "mark_done"):
        raise HTTPException(400, "kind must be approve, reject, cancel, or mark_done.")
    if kind == "reject":
        with (
            ctx.registry.dispatch_lock,
            ctx.execution_lifecycle.admission_scope(),
            ctx.session_store.mutation_scope(session_id),
        ):
            session = get_session_for_actor(ctx.session_store, session_id, actor)
            _assert_rejectable(session, ctx)
            return SessionController(ctx.session_store).record_decision(
                session_id, kind, string_field(body, "note") or None,
                valid_agent(body.get("targetAgent")),
                actor_user_id=actor["userId"],
            )
    task_id = task_owner = None
    if kind in ("cancel", "mark_done"):
        run_request = ctx.registry.daemon_store.active_run_request_for_session_any_node(
            session_id
        )
        # Resolved before cancelling, which ends the request's task authority.
        task_id, task_owner = thread_task_scope(
            session, run_request, ctx.task_store, ctx.registry.daemon_store
        )
    controller = SessionController(
        ctx.session_store,
        task_store=ctx.task_store,
        task_id=task_id,
        task_execution_owner=task_owner,
        owner_user_id=actor["userId"],
    )
    if kind in ("cancel", "mark_done"):
        if run_request:
            terminal_reason = string_field(body, "note") or (
                "Session marked done by user."
                if kind == "mark_done"
                else "Cancelled by user."
            )
            ctx.registry.cancel_run_request_before_delivery(
                run_request["id"], terminal_reason
            )
            if ctx.registry.get(run_request["nodeId"]):
                ctx.registry.cancel_active_run(
                    run_request["nodeId"], session_id, terminal_reason
                )
    result = controller.record_decision(
        session_id,
        kind,
        string_field(body, "note") or None,
        valid_agent(body.get("targetAgent")),
        actor_user_id=actor["userId"],
    )
    logger.info("Session decision recorded", session_id=session_id, kind=kind)
    return result


@router.post("/threads/{session_id}/permission-requests/{request_id}")
def answer_permission_request(
    session_id: str,
    request_id: str,
    request: Request,
    ctx: AppContextDep,
    *,
    _request_body: JsonBodyDep,
) -> dict[str, Any]:
    # Like a decision, only a person answers: the node token an agent can
    # reach never authenticates as one.
    actor = request_actor_or_sandbox(request, ctx.auth_store, ctx.registry)
    get_session_for_actor(ctx.session_store, session_id, actor)
    body = _request_body
    decision = body.get("decision")
    if decision not in PERMISSION_DECISIONS:
        raise HTTPException(400, "decision must be allow or deny.")
    note = string_field(body, "note")
    if len(note) > PERMISSION_NOTE_MAX_CHARS:
        raise HTTPException(400, "note is too long.")
    result = SessionController(ctx.session_store).resolve_permission_request(
        session_id, request_id, decision, note or None, actor_user_id=actor["userId"]
    )
    if result is None:
        raise HTTPException(409, "permission_request_closed")
    return result


@router.post("/threads/{session_id}/handoffs")
def handoff(
    session_id: str, request: Request, ctx: AppContextDep, *, _request_body: JsonBodyDep
) -> dict[str, Any]:
    actor = request_actor_or_sandbox(request, ctx.auth_store, ctx.registry)
    get_session_for_actor(ctx.session_store, session_id, actor)
    body = _request_body
    target_agent = valid_agent(body.get("targetAgent"))
    if not target_agent:
        raise HTTPException(
            400, f"targetAgent must be one of: {', '.join(AGENT_NAMES)}."
        )
    controller = SessionController(
        ctx.session_store,
        task_store=ctx.task_store,
        owner_user_id=actor["userId"],
    )
    result = controller.handoff_session(
        session_id,
        target_agent,
        [{"agent": target_agent, "role": role_name(body.get("role"))}],
        string_field(body, "note") or None,
    )
    logger.info(
        "Session handoff recorded",
        session_id=session_id,
        target_agent=target_agent,
    )
    return result


# Session lifecycle states after which no further events are appended; the
# stream flushes the backlog and closes when it sees one of these.
TERMINAL_SESSION_STATUSES = frozenset({"completed", "failed", "cancelled"})
# Agent subprocesses emit output in small chunks, but this tail loop is the
# final hop before the browser; its knobs are validated in core/settings.py.
_STREAM_SETTINGS = StreamSettings.from_env()
_STREAM_FALLBACK_SECONDS = _STREAM_SETTINGS.fallback_seconds
_STREAM_EVENT_PAGE_LIMIT = _STREAM_SETTINGS.event_page_limit
_STREAM_HEARTBEAT_SECONDS = 15.0
_STREAM_MAX_SECONDS = _STREAM_SETTINGS.max_seconds


def _sse_frame(data: dict[str, Any], *, event: str | None = None) -> str:
    event_id = data.get("id")
    prefix = f"id: {event_id}\n" if isinstance(event_id, str) and event_id else ""
    prefix += f"event: {event}\n" if event else ""
    return f"{prefix}data: {json.dumps(data)}\n\n"


@dataclass
class _EventTail:
    """Where one SSE connection stands in a thread's event log."""

    after_event_id: str | None
    start: float
    last_heartbeat: float
    next_sequence: int | None = None


def _open_event_tail(request: Request) -> _EventTail:
    # EventSource keeps the original URL across automatic reconnects but
    # advances Last-Event-ID as frames arrive. Prefer that live cursor over
    # the URL's initial `after` value so a reconnect does not replay the
    # entire stream window.
    after_event_id = request.headers.get("last-event-id") or request.query_params.get("after")
    start = time.monotonic()
    return _EventTail(after_event_id=after_event_id, start=start, last_heartbeat=start)


async def _read_tail_page(
    ctx: AppContext, session_id: str, tail: _EventTail
) -> dict[str, Any] | None:
    """The next page after the tail's cursor, advancing it; None once the thread is gone."""
    try:
        page = await run_in_threadpool(
            ctx.session_store.read_event_page,
            session_id,
            after_event_id=tail.after_event_id if tail.next_sequence is None else None,
            after_sequence=tail.next_sequence,
            limit=_STREAM_EVENT_PAGE_LIMIT,
        )
    except KeyError:
        return None
    tail.next_sequence = page["nextSequence"]
    return page


def _finished_frame(page: dict[str, Any]) -> str | None:
    """The closing frame once a terminal thread's history is fully sent."""
    status = page.get("status")
    history_drained = page["nextSequence"] >= int(page.get("version") or 0)
    if status in TERMINAL_SESSION_STATUSES and history_drained:
        return _sse_frame({"status": status}, event="done")
    return None


def _timer_frames(tail: _EventTail, status: Any, now: float) -> tuple[list[str], bool]:
    """A due heartbeat, then the timeout close; True when the stream must end."""
    frames: list[str] = []
    if now - tail.last_heartbeat >= _STREAM_HEARTBEAT_SECONDS:
        timestamp = datetime.now(UTC).isoformat().replace("+00:00", "Z")
        frames.append(_sse_frame({"timestamp": timestamp}, event="heartbeat"))
        tail.last_heartbeat = now
    if now - tail.start >= _STREAM_MAX_SECONDS:
        frames.append(_sse_frame({"status": status, "reason": "timeout"}, event="done"))
        return frames, True
    return frames, False


def _tail_wait_seconds(tail: _EventTail, now: float) -> float:
    wait_seconds = min(
        _STREAM_FALLBACK_SECONDS,
        _STREAM_HEARTBEAT_SECONDS - (now - tail.last_heartbeat),
        _STREAM_MAX_SECONDS - (now - tail.start),
    )
    return max(0.001, wait_seconds)


@router.get("/threads/{session_id}/events")
async def session_events(
    session_id: str, request: Request, ctx: AppContextDep
) -> StreamingResponse:
    actor = await run_in_threadpool(request_actor_or_sandbox, request, ctx.auth_store, ctx.registry)
    # Authorize before the stream opens so 403/404 surface as normal responses.
    await run_in_threadpool(
        get_session_header_for_actor, ctx.session_store, session_id, actor
    )

    async def event_stream() -> AsyncIterator[str]:
        # Server-side tail-poll: read only newly appended rows from the event
        # log each tick. The web client coalesces that tick's message frames
        # into one render commit, while other SSE consumers keep the existing
        # one-domain-event-per-frame contract.
        tail = _open_event_tail(request)
        notification_key = session_event_key(session_id)
        notifier = ctx.control_plane_notifier
        while not await request.is_disconnected():
            with notifier.observe(notification_key) as observed_version:
                page = await _read_tail_page(ctx, session_id, tail)
                if page is None:
                    return
                events = page["events"]
                for event in events:
                    yield _sse_frame(event)
                if events:
                    tail.last_heartbeat = time.monotonic()
                finished = _finished_frame(page)
                if finished is not None:
                    yield finished
                    return
                now = time.monotonic()
                frames, timed_out = _timer_frames(tail, page.get("status"), now)
                for frame in frames:
                    yield frame
                if timed_out:
                    return
                if events:
                    continue
                await notifier.wait(
                    notification_key, observed_version, timeout=_tail_wait_seconds(tail, now)
                )

    return StreamingResponse(
        event_stream(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@router.get("/threads/{session_id}/artifacts/{artifact_id}")
async def read_artifact(
    session_id: str, artifact_id: str, request: Request, ctx: AppContextDep
) -> Any:
    actor = await run_in_threadpool(
        request_actor_or_sandbox, request, ctx.auth_store, ctx.registry
    )
    session = await run_in_threadpool(
        get_session_for_actor, ctx.session_store, session_id, actor
    )
    artifact = session_artifact(session, artifact_id)
    if artifact and is_workspace_artifact(artifact):
        # Workspace paths belong to the execution plane. A same-named host
        # file is never evidence that this backend shares the daemon's storage.
        read_content = getattr(ctx.session_store, "read_artifact_content", None)
        content = (
            await run_in_threadpool(read_content, session_id, artifact_id)
            if read_content
            else None
        )
        if content is None:
            # The daemon snapshots only small document types; every other file
            # it reports is read back from the computer that wrote it.
            content = await _live_artifact_content(ctx, session, artifact)
        return Response(
            content,
            media_type=artifact.get("contentType") or "application/octet-stream",
            headers={
                "Content-Disposition": (
                    "attachment; filename*=UTF-8''"
                    + quote(str(artifact.get("title") or artifact_id), safe="")
                ),
                "Content-Security-Policy": (
                    "sandbox; default-src 'none'; base-uri 'none'; "
                    "frame-ancestors 'none'"
                ),
            },
        )
    try:
        text = await run_in_threadpool(
            ctx.session_store.read_artifact, session_id, artifact_id
        )
    except (KeyError, FileNotFoundError, OSError):
        raise HTTPException(404, "Artifact not found.") from None
    return PlainTextResponse(text)


async def _live_artifact_content(
    ctx: AppContext, session: dict[str, Any], artifact: dict[str, Any]
) -> bytes:
    """A generated file's current bytes, read from its thread's workspace.

    Only the path the daemon itself reported is read, through the same
    `workspace.read` command the task and project browsers use. A file past
    the live read limit is refused rather than served cut short."""
    relative = artifact.get("workspaceRelativePath")
    if not isinstance(relative, str) or not relative:
        raise HTTPException(404, "Artifact not found.")
    path = workspace_path(relative, required=True)
    nodes = await run_in_threadpool(ctx.registry.monitor_nodes)
    binding = recorded_session_workspace(session, nodes)
    if not binding:
        raise HTTPException(404, "Artifact not found.")
    node, layout, subpath = workspace_binding_target(nodes, binding)
    event = await dispatch_workspace_command(
        ctx,
        node,
        workspace_binding_command(
            routing_id=session["id"],
            command_id=new_database_id(),
            command_type="workspace.read",
            path=path,
            workspace_layout=layout,
            workspace_subpath=subpath,
        ),
    )
    raise_workspace_error(event)
    if event.get("truncated"):
        raise HTTPException(
            413, {"reason": "artifact-too-large", "code": "artifact-too-large"}
        )
    raw = event.get("contentBase64")
    return base64.b64decode(raw) if isinstance(raw, str) else b""
