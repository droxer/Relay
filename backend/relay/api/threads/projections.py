from __future__ import annotations

from typing import Any

from fastapi import HTTPException

from ...collaboration.awaiting import task_awaiting
from ...core.workspace_artifacts import workspace_artifacts
from ...security.actor import Actor
from ..deps import AppContext


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
