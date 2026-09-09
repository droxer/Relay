"""Resolve task execution and browsing from one durable workspace binding."""

from __future__ import annotations

from typing import Any

from ..core.computer_identity import computer_id

TASK_WORKSPACE_ROOT = "tasks"
WORKSPACE_LAYOUT_TASK = "task"
WORKSPACE_LAYOUT_THREAD = "thread"
WORKSPACE_LAYOUT_PROJECT = "project"
DAEMON_CAPABILITY_TASK_WORKSPACES = "task-workspaces"


def task_workspace_subpath(task: dict[str, Any]) -> str:
    routine_id = task.get("sourceRoutineId")
    if isinstance(routine_id, str) and routine_id:
        return f"{TASK_WORKSPACE_ROOT}/{routine_id}/{task['id']}"
    return f"{TASK_WORKSPACE_ROOT}/{task['id']}"


def recorded_task_workspace(
    task: dict[str, Any],
    session_store: Any | None = None,
    nodes: list[dict[str, Any]] | None = None,
) -> dict[str, Any] | None:
    """Prefer the durable task event; recover legacy layout from recorded sessions.

    Never infer a legacy path from today's project membership or routine id.
    The newest surviving session preserves the historical browsing convention.
    """
    if task.get("workspaceBinding"):
        return dict(task["workspaceBinding"])
    if session_store is None:
        return None
    by_id = {node["id"]: node for node in nodes or []}
    for session_id in reversed(task.get("linkedSessionIds") or []):
        try:
            session = session_store.get_session(session_id)
        except (KeyError, FileNotFoundError):
            continue
        if not session:
            continue
        layout = session.get("workspaceLayout") or "node-root"
        identity = session.get("computerId")
        node_id = session.get("daemonNodeId")
        if not identity and session.get("managedNodeId"):
            identity = f"managed:{session['managedNodeId']}"
        if not identity and node_id in by_id:
            identity = computer_id(by_id[node_id])
        return {
            "computerId": identity or f"node:{node_id}",
            "layout": layout,
            "subpath": session.get("workspaceSubpath"),
            "sessionId": session_id,
        }
    return None


def task_workspace_nodes(
    task: dict[str, Any], nodes: list[dict[str, Any]], session_store: Any | None = None
) -> list[dict[str, Any]]:
    binding = recorded_task_workspace(task, session_store, nodes)
    if not binding:
        return nodes
    return [node for node in nodes if computer_id(node) == binding["computerId"]]


def resolve_task_workspace(
    task: dict[str, Any],
    *,
    node: dict[str, Any] | None,
    project_snapshot: dict[str, Any] | None = None,
    session_store: Any | None = None,
) -> tuple[str, str | None]:
    binding = recorded_task_workspace(task, session_store, [node] if node else [])
    capabilities = (node or {}).get("capabilities") or []
    if binding:
        if not node or computer_id(node) != binding["computerId"]:
            raise ValueError(
                "workspace_unavailable: this task's files are on another Computer."
            )
        if binding.get("workspaceRoot") and binding["workspaceRoot"] != node.get(
            "workspacePath"
        ):
            raise ValueError(
                "workspace_unavailable: this Computer's workspace root changed; restore it before resuming."
            )
        layout, subpath = binding["layout"], binding.get("subpath")
    elif task.get("linkedSessionIds"):
        raise ValueError(
            "workspace_unavailable: this task's recorded workspace cannot be recovered."
        )
    elif project_snapshot:
        layout, subpath = WORKSPACE_LAYOUT_PROJECT, project_snapshot["workspaceSubpath"]
    else:
        layout, subpath = WORKSPACE_LAYOUT_TASK, task_workspace_subpath(task)
    required = {
        "task": DAEMON_CAPABILITY_TASK_WORKSPACES,
        "project": "project-workspaces",
    }.get(layout)
    if required and required not in capabilities:
        raise ValueError(
            f"workspace_unavailable: this Computer needs {required} support; upgrade its daemon."
        )
    if layout in ("task", "project") and not subpath:
        raise ValueError(
            "workspace_unavailable: the recorded workspace path is missing."
        )
    return layout, subpath
