from __future__ import annotations

import json
import os
import time
from collections.abc import AsyncIterator
from datetime import datetime, timezone
from typing import Any
from urllib.parse import quote

from fastapi import APIRouter, HTTPException, Request, Response
from fastapi.responses import PlainTextResponse, StreamingResponse
from loguru import logger
from starlette.concurrency import run_in_threadpool

from ..core.computer_identity import computer_id as resolve_computer_id
from ..core.models import AGENT_NAMES
from ..persistence.stores import valid_agent
from ..services.event_notifier import session_event_key
from ..services.team_dispatch import (
    TeamDispatchError,
    task_thread_assignments,
    task_thread_ownership,
)
from ..sessions import SessionArchivedError, SessionController, SessionRunInFlightError
from .deps import AppContext, AppContextDep
from .helpers import (
    artifact_index_item,
    assignment_list,
    get_session_for_actor,
    get_session_header_for_actor,
    get_task_for_actor,
    is_workspace_artifact,
    json_body,
    owner_employee_id_for_create,
    request_actor,
    request_actor_or_sandbox,
    role_name,
    string_field,
    workspace_artifacts,
)
from .project_helpers import (
    ensure_project_node_matches,
    project_for_owner,
    project_session_fields,
)

router = APIRouter()


ACTIVE_TASK_STATUSES = frozenset(
    {"assigned", "running", "waiting_for_human", "review", "blocked"}
)
ACTIVE_SESSION_STATUSES = frozenset({"running", "waiting_for_human"})


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
        "title": session.get("title"),
        "taskGoal": session.get("taskGoal"),
        "status": session.get("status"),
        "phase": session.get("phase"),
        "daemonNodeId": session.get("daemonNodeId"),
        "managedNodeId": session.get("managedNodeId"),
        "workspacePath": session.get("workspacePath"),
        "ownerEmployeeId": session.get("ownerEmployeeId"),
        "ownerAgentId": session.get("ownerAgentId"),
        "teamId": session.get("teamId"),
        "projectId": session.get("projectId"),
        "workspaceLayout": session.get("workspaceLayout"),
        "workspaceSubpath": session.get("workspaceSubpath"),
        "computerId": session.get("computerId"),
        "currentAgent": session.get("currentAgent"),
        "pendingDecision": session.get("pendingDecision"),
        "archived": session.get("archived", False),
        "artifactCount": len(workspace_artifacts(session)),
        "runCount": len(session.get("agentRuns", [])),
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
        "ownerEmployeeId": task.get("ownerEmployeeId"),
        "projectId": task.get("projectId"),
        "assigneeEmployeeId": task.get("assigneeEmployeeId"),
        "assignedAgent": task.get("assignedAgent"),
        "assignedAgentId": task.get("assignedAgentId"),
        "assignedTeamId": task.get("assignedTeamId"),
        "dueDate": task.get("dueDate"),
        "isRoutine": task.get("isRoutine", False),
        "routineType": task.get("routineType"),
        "routineCadence": task.get("routineCadence"),
        "routineNextRunDate": task.get("routineNextRunDate"),
        "routineEnabled": task.get("routineEnabled", False),
        "linkedSessionIds": task.get("linkedSessionIds", []),
        "updatedAt": task.get("updatedAt"),
        "createdAt": task.get("createdAt"),
    }


def employee_for_workspace_brief(
    actor: dict[str, Any], requested_employee: str | None
) -> str:
    requested = (
        requested_employee.strip() if isinstance(requested_employee, str) else ""
    )
    if requested and actor["isAdmin"]:
        return requested
    if requested and requested != actor["employeeId"]:
        raise HTTPException(403, "Cannot read another employee's workspace.")
    return actor["employeeId"]


def agent_supervisor_employee_id(agent: dict[str, Any]) -> str | None:
    """Return an agent's owner across current and legacy agent snapshots."""
    owner = agent.get("supervisorEmployeeId") or agent.get("employeeId")
    return owner if isinstance(owner, str) and owner else None


def agent_for_workspace(
    ctx: AppContext, actor: dict[str, Any], requested_agent: str | None
) -> dict[str, Any] | None:
    agent_id = requested_agent.strip() if isinstance(requested_agent, str) else ""
    if not agent_id:
        return None
    agent = ctx.agent_store.get_agent(agent_id)
    if not agent or agent.get("deletedAt"):
        raise HTTPException(404, "Agent not found.")
    if (
        not actor["isAdmin"]
        and agent_supervisor_employee_id(agent) != actor["employeeId"]
    ):
        raise HTTPException(403, "Cannot read another employee's agent workspace.")
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
async def list_sessions(request: Request, ctx: AppContextDep) -> dict[str, Any]:
    actor = request_actor_or_sandbox(request, ctx.auth_store, ctx.registry)
    if request.query_params.get("view") == "summary":
        try:
            requested_limit = int(request.query_params.get("limit") or "100")
        except ValueError as error:
            raise HTTPException(400, "limit must be an integer.") from error
        summaries = await run_in_threadpool(
            ctx.session_store.list_session_summaries,
            owner_employee_id=None if actor["isAdmin"] else actor["employeeId"],
            limit=min(max(1, requested_limit), 200),
        )
        sessions = ensure_sessions_managed_affinity(ctx, summaries)
        return {"sessions": [session_brief_item(session) for session in sessions]}
    visible = [
        session
        for session in ctx.session_store.list_sessions()
        if actor["isAdmin"] or session.get("ownerEmployeeId") == actor["employeeId"]
    ]
    sessions = ensure_sessions_managed_affinity(ctx, visible)
    return {"sessions": sessions}


ARTIFACT_INDEX_DEFAULT_LIMIT = 200
ARTIFACT_INDEX_MAX_LIMIT = 1000


def artifact_index_limit(raw: str | None) -> int:
    if raw is None or not raw.strip():
        return ARTIFACT_INDEX_DEFAULT_LIMIT
    try:
        value = int(raw)
    except ValueError:
        raise HTTPException(400, "limit must be an integer.")
    if value < 1:
        raise HTTPException(400, "limit must be at least 1.")
    return min(value, ARTIFACT_INDEX_MAX_LIMIT)


@router.get("/artifacts")
async def list_artifacts(request: Request, ctx: AppContextDep) -> dict[str, Any]:
    actor = request_actor_or_sandbox(request, ctx.auth_store, ctx.registry)
    requested_employee = request.query_params.get("employeeId")
    if (
        requested_employee
        and not actor["isAdmin"]
        and requested_employee != actor["employeeId"]
    ):
        raise HTTPException(403, "Cannot list artifacts for another employee.")
    workspace_path = request.query_params.get("workspacePath")
    limit = artifact_index_limit(request.query_params.get("limit"))
    artifacts: list[dict[str, Any]] = []
    for session in ctx.session_store.list_sessions():
        owner = session.get("ownerEmployeeId")
        if not actor["isAdmin"] and owner != actor["employeeId"]:
            continue
        if requested_employee and owner != requested_employee:
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
async def workspace_brief(request: Request, ctx: AppContextDep) -> dict[str, Any]:
    actor = request_actor_or_sandbox(request, ctx.auth_store, ctx.registry)
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
        and team.get("ownerEmployeeId") != actor["employeeId"]
    ):
        raise HTTPException(403, "Cannot read another employee's team workspace.")

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
        and project.get("ownerEmployeeId") != actor["employeeId"]
    ):
        raise HTTPException(403, "Cannot read another employee's project workspace.")

    agent = agent_for_workspace(ctx, actor, requested_agent_id)
    employee_id = (
        project.get("ownerEmployeeId")
        if project
        else team.get("ownerEmployeeId")
        if team
        else agent_supervisor_employee_id(agent)
        if agent
        else employee_for_workspace_brief(actor, request.query_params.get("employeeId"))
    )
    if not employee_id:
        raise HTTPException(404, "Agent owner not found.")

    sessions = [
        session
        for session in ctx.session_store.list_sessions()
        if session.get("ownerEmployeeId") == employee_id
        and (not agent or session_uses_agent(session, agent["id"]))
        and (not team or session.get("teamId") == team["id"])
        and (not project or session.get("projectId") == project["id"])
    ]
    sessions = ensure_sessions_managed_affinity(ctx, sessions)
    scoped_session_ids = (
        {session["id"] for session in sessions} if team or project else set()
    )
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
            else node.get("employeeId") == employee_id
            if placements is None
            else has_placement or has_authorized_run
        )
        if include_node:
            nodes.append(node)
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
        for task in ctx.task_store.list_tasks()
        if (
            task.get("ownerEmployeeId") == employee_id
            or task.get("assigneeEmployeeId") == employee_id
        )
        and (not agent or task.get("assignedAgentId") == agent["id"])
        and (not team or task.get("assignedTeamId") == team["id"])
        and (not project or task.get("projectId") == project["id"])
    ]
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
        "employeeId": employee_id,
        **({"agentId": agent["id"]} if agent else {}),
        **({"teamId": team["id"]} if team else {}),
        **({"projectId": project["id"]} if project else {}),
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
                ]
            ),
            "taskCount": len(tasks),
            "activeTaskCount": len(active_tasks),
            "artifactCount": len(artifacts),
        },
        "generatedAt": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
    }


@router.post("/threads", status_code=201)
async def create_session(request: Request, ctx: AppContextDep) -> dict[str, Any]:
    actor = request_actor_or_sandbox(request, ctx.auth_store, ctx.registry)
    body = await json_body(request)
    task_goal = string_field(body, "taskGoal")
    if not task_goal:
        raise HTTPException(400, "taskGoal is required.")
    assignments = assignment_list(body.get("assignments"))
    owner_agent_id = next(
        (
            assignment.get("agentId")
            for assignment in assignments
            if assignment.get("agentId")
        ),
        None,
    )
    workspace_path = string_field(body, "workspacePath") or "/workspace"
    daemon_node_id = string_field(body, "daemonNodeId") or string_field(
        body, "daemon_node_id"
    )
    managed_node_id = None
    session_computer_id = None
    task_id = body.get("taskId") if isinstance(body.get("taskId"), str) else None
    task = get_task_for_actor(ctx.task_store, task_id, actor) if task_id else None
    requested_project_id = string_field(body, "projectId") or None
    task_project_id = task.get("projectId") if task else None
    if requested_project_id and task_project_id and requested_project_id != task_project_id:
        raise HTTPException(400, "thread_project_task_mismatch")
    project_id = task_project_id or requested_project_id
    if project_id and "assignments" in body:
        raise HTTPException(400, "project_assignment_override_unsupported")
    owner = owner_employee_id_for_create(actor, body)
    thread_ownership = {
        "owner_employee_id": owner,
        **({"owner_agent_id": owner_agent_id} if owner_agent_id else {}),
    }
    if task:
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
        expected_owner = thread_ownership.get("owner_employee_id")
        requested_owner = string_field(body, "ownerEmployeeId") or string_field(
            body, "employeeId"
        )
        if requested_owner and requested_owner != expected_owner:
            raise HTTPException(
                403, "Session owner must match the linked task assignee."
            )
        owner = expected_owner or owner
        if owner and "owner_employee_id" not in thread_ownership:
            thread_ownership["owner_employee_id"] = owner
    if daemon_node_id:
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
        if owner and node.get("employeeId") != owner:
            raise HTTPException(
                403, "The selected computer belongs to another employee."
            )
        managed_node_id = node.get("managedNodeId")
        session_computer_id = resolve_computer_id(node)
    else:
        node = None
    project = project_for_owner(ctx, project_id, owner) if project_id and owner else None
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


@router.get("/threads/{session_id}")
def get_session(
    session_id: str, request: Request, ctx: AppContextDep
) -> dict[str, Any]:
    actor = request_actor_or_sandbox(request, ctx.auth_store, ctx.registry)
    return ensure_session_managed_affinity(
        ctx, get_session_for_actor(ctx.session_store, session_id, actor)
    )


@router.patch("/threads/{session_id}")
async def update_session(
    session_id: str, request: Request, ctx: AppContextDep
) -> dict[str, Any]:
    actor = request_actor_or_sandbox(request, ctx.auth_store, ctx.registry)
    get_session_for_actor(ctx.session_store, session_id, actor)
    body = await json_body(request)
    unknown = set(body) - {"title", "archived"}
    if unknown or not body:
        fields = ", ".join(sorted(unknown)) if unknown else "none"
        raise HTTPException(400, f"Unsupported thread field(s): {fields}.")
    controller = SessionController(
        ctx.session_store,
        task_store=ctx.task_store,
        owner_employee_id=actor["employeeId"],
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
async def cancel_session_run(
    session_id: str, request: Request, ctx: AppContextDep
) -> dict[str, Any]:
    actor = request_actor_or_sandbox(request, ctx.auth_store, ctx.registry)
    session = get_session_for_actor(ctx.session_store, session_id, actor)
    body = await json_body(request)
    reason = string_field(body, "reason") or "Cancelled by employee."
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
    if node_id:
        cancelled = ctx.backend.cancel_run(
            node_id,
            session_id,
            reason,
            actor_employee_id=None if actor.get("isAdmin") else actor["employeeId"],
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
        task_id=session.get("taskId"),
        owner_employee_id=actor["employeeId"],
    ).cancel_session(session_id, reason)


@router.post("/threads/{session_id}/assignments")
async def assign_session(
    session_id: str, request: Request, ctx: AppContextDep
) -> dict[str, Any]:
    actor = request_actor_or_sandbox(request, ctx.auth_store, ctx.registry)
    get_session_for_actor(ctx.session_store, session_id, actor)
    body = await json_body(request)
    assignments = assignment_list(body.get("assignments"))
    if not assignments:
        raise HTTPException(400, "assignments must include at least one agent.")
    controller = SessionController(
        ctx.session_store,
        task_store=ctx.task_store,
        owner_employee_id=actor["employeeId"],
    )
    try:
        controller.assign_session(session_id, assignments)
    except SessionArchivedError:
        raise HTTPException(409, "Session is archived.")
    except SessionRunInFlightError:
        raise HTTPException(409, "Session has a run in flight.")
    return ctx.session_store.get_session(session_id)


@router.delete("/threads/{session_id}", status_code=204)
async def delete_session(
    session_id: str, request: Request, ctx: AppContextDep
) -> Response:
    actor = request_actor(request, ctx.auth_store)
    controller = SessionController(
        ctx.session_store,
        task_store=ctx.task_store,
        owner_employee_id=actor["employeeId"],
    )
    try:
        with ctx.registry.dispatch_lock:
            snapshot = get_session_for_actor(ctx.session_store, session_id, actor)
            if ctx.registry.daemon_store.active_run_request_for_session_any_node(
                session_id
            ):
                raise SessionRunInFlightError(session_id)
            controller.delete_session(
                session_id, snapshot=snapshot, deleted_by=actor["employeeId"]
            )
    except SessionRunInFlightError:
        raise HTTPException(409, "Session has a run in flight.")
    ctx.chat_store.clear_conversation_sessions(session_id)
    return Response(status_code=204)


@router.post("/threads/{session_id}/decisions")
async def decision(
    session_id: str, request: Request, ctx: AppContextDep
) -> dict[str, Any]:
    actor = request_actor_or_sandbox(request, ctx.auth_store, ctx.registry)
    get_session_for_actor(ctx.session_store, session_id, actor)
    body = await json_body(request)
    kind = body.get("kind")
    if kind not in ("approve", "reject", "cancel", "rerun", "handoff", "mark_done"):
        raise HTTPException(
            400, "kind must be approve, reject, cancel, rerun, handoff, or mark_done."
        )
    controller = SessionController(
        ctx.session_store,
        task_store=ctx.task_store,
        owner_employee_id=actor["employeeId"],
    )
    if kind in ("cancel", "mark_done"):
        run_request = ctx.registry.daemon_store.active_run_request_for_session_any_node(
            session_id
        )
        if run_request:
            terminal_reason = string_field(body, "note") or (
                "Session marked done by employee."
                if kind == "mark_done"
                else "Cancelled by employee."
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
    )
    logger.info("Session decision recorded", session_id=session_id, kind=kind)
    return result


@router.post("/threads/{session_id}/handoffs")
async def handoff(
    session_id: str, request: Request, ctx: AppContextDep
) -> dict[str, Any]:
    actor = request_actor_or_sandbox(request, ctx.auth_store, ctx.registry)
    get_session_for_actor(ctx.session_store, session_id, actor)
    body = await json_body(request)
    target_agent = valid_agent(body.get("targetAgent"))
    if not target_agent:
        raise HTTPException(
            400, f"targetAgent must be one of: {', '.join(AGENT_NAMES)}."
        )
    controller = SessionController(
        ctx.session_store,
        task_store=ctx.task_store,
        owner_employee_id=actor["employeeId"],
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
# final hop before the browser. A 50 ms tail interval feels continuous while
# still batching subprocess chunks into a single browser cache update.
_STREAM_FALLBACK_SECONDS = max(
    1.0, float(os.environ.get("RELAY_STREAM_FALLBACK_SECONDS", "5"))
)
_STREAM_EVENT_PAGE_LIMIT = max(
    1, min(1000, int(os.environ.get("RELAY_STREAM_EVENT_PAGE_LIMIT", "256")))
)
_STREAM_HEARTBEAT_SECONDS = 15.0
# Upper bound on a single SSE connection. The client reconnects with
# Last-Event-ID, so capping the connection only costs a reconnect. Configurable
# because a CDN or platform proxy in front of the backend may cut a stream at
# its own (shorter) limit; setting this below that limit turns an opaque proxy
# disconnect into a clean, resumable `done` frame.
_STREAM_MAX_SECONDS = max(
    5.0, float(os.environ.get("RELAY_STREAM_MAX_SECONDS", str(60 * 30)))
)


def _sse_frame(data: dict[str, Any], *, event: str | None = None) -> str:
    event_id = data.get("id")
    prefix = f"id: {event_id}\n" if isinstance(event_id, str) and event_id else ""
    prefix += f"event: {event}\n" if event else ""
    return f"{prefix}data: {json.dumps(data)}\n\n"


@router.get("/threads/{session_id}/events")
async def session_events(
    session_id: str, request: Request, ctx: AppContextDep
) -> StreamingResponse:
    actor = request_actor_or_sandbox(request, ctx.auth_store, ctx.registry)
    # Authorize before the stream opens so 403/404 surface as normal responses.
    await run_in_threadpool(
        get_session_header_for_actor, ctx.session_store, session_id, actor
    )

    async def event_stream() -> AsyncIterator[str]:
        # Server-side tail-poll: read only newly appended rows from the event
        # log each tick. The web client coalesces that tick's message frames
        # into one render commit, while other SSE consumers keep the existing
        # one-domain-event-per-frame contract.
        # EventSource keeps the original URL across automatic reconnects but
        # advances Last-Event-ID as frames arrive. Prefer that live cursor over
        # the URL's initial `after` value so a reconnect does not replay the
        # entire stream window.
        after_event_id = request.headers.get(
            "last-event-id"
        ) or request.query_params.get("after")
        next_sequence: int | None = None
        start = time.monotonic()
        last_heartbeat = start
        notification_key = session_event_key(session_id)
        while True:
            if await request.is_disconnected():
                return
            with ctx.control_plane_notifier.observe(
                notification_key
            ) as observed_version:
                try:
                    page = await run_in_threadpool(
                        ctx.session_store.read_event_page,
                        session_id,
                        after_event_id=(
                            after_event_id if next_sequence is None else None
                        ),
                        after_sequence=next_sequence,
                        limit=_STREAM_EVENT_PAGE_LIMIT,
                    )
                except KeyError:
                    return
                events = page["events"]
                next_sequence = page["nextSequence"]
                if events:
                    for event in events:
                        yield _sse_frame(event)
                    last_heartbeat = time.monotonic()
                status = page.get("status")
                history_drained = next_sequence >= int(page.get("version") or 0)
                if status in TERMINAL_SESSION_STATUSES and history_drained:
                    yield _sse_frame({"status": status}, event="done")
                    return
                now = time.monotonic()
                if now - last_heartbeat >= _STREAM_HEARTBEAT_SECONDS:
                    yield _sse_frame(
                        {
                            "timestamp": datetime.now(timezone.utc)
                            .isoformat()
                            .replace("+00:00", "Z")
                        },
                        event="heartbeat",
                    )
                    last_heartbeat = now
                if now - start >= _STREAM_MAX_SECONDS:
                    yield _sse_frame(
                        {"status": status, "reason": "timeout"}, event="done"
                    )
                    return
                if events:
                    continue
                wait_seconds = min(
                    _STREAM_FALLBACK_SECONDS,
                    _STREAM_HEARTBEAT_SECONDS - (now - last_heartbeat),
                    _STREAM_MAX_SECONDS - (now - start),
                )
                await ctx.control_plane_notifier.wait(
                    notification_key,
                    observed_version,
                    timeout=max(0.001, wait_seconds),
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
    actor = request_actor_or_sandbox(request, ctx.auth_store, ctx.registry)
    session = get_session_for_actor(ctx.session_store, session_id, actor)
    artifact = session_artifact(session, artifact_id)
    if artifact and is_workspace_artifact(artifact):
        # Workspace paths belong to the execution plane. A same-named host
        # file is never evidence that this backend shares the daemon's storage.
        read_content = getattr(ctx.session_store, "read_artifact_content", None)
        content = read_content(session_id, artifact_id) if read_content else None
        if content is not None:
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
        raise HTTPException(404, "Artifact not found.")
    try:
        return PlainTextResponse(
            ctx.session_store.read_artifact(session_id, artifact_id)
        )
    except (KeyError, FileNotFoundError, OSError):
        raise HTTPException(404, "Artifact not found.")
