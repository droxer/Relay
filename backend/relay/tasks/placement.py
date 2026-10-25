"""Where a task can run: ready-node selection, managed capacity, and legacy
assignment materialization shared by the scheduler and task dispatch."""

from __future__ import annotations

from typing import Any

from loguru import logger

from ..core.computer_identity import computer_id
from ..daemon_registry.scheduling import node_accepts_run
from ..persistence.agent.placements import create_node_placement
from ..core.validation import valid_agent
from ..teams.dispatch import (
    task_execution_user_id,
)


def task_goal_text(task: dict[str, Any]) -> str:
    return (
        f"{task['title']}\n\n{task['description']}"
        if task.get("description")
        else task["title"]
    )


def materialize_legacy_agent_assignment(
    task: dict[str, Any],
    executor_kind: str,
    *,
    registry: Any,
    agent_store: Any,
    placement_store: Any,
) -> dict[str, Any] | None:
    user_id = task_execution_user_id(task)
    if not user_id:
        return None
    assignment = {"agent": executor_kind}
    node = ready_node_for_task(registry, task, [assignment])
    if not node:
        return None
    node_computer_id = computer_id(node)
    candidates = sorted(
        (
            agent
            for agent in agent_store.list_agents(supervisor_user_id=user_id)
            if not agent.get("deletedAt")
            and agent.get("enabled", True)
            and agent["executorKind"] == executor_kind
            and agent.get("computerId") == node_computer_id
        ),
        key=lambda agent: (agent.get("createdAt") or "", agent["id"]),
    )
    if not candidates:
        logger.info(
            "No declared agent for this runtime; task stays queued",
            user_id=user_id,
            executor_kind=executor_kind,
            computer_id=node_computer_id,
        )
        return None
    agent = candidates[0]
    placement = next(
        (
            item
            for item in placement_store.list_placements(agent_id=agent["id"])
            if item.get("computerId") == node_computer_id
            or (not item.get("computerId") and item["daemonNodeId"] == node["id"])
        ),
        None,
    )
    if placement is None:
        create_node_placement(placement_store, agent, node)
    return {"agent": executor_kind, "agentId": agent["id"]}


def materialize_legacy_task_assignment(
    task: dict[str, Any],
    *,
    task_store: Any,
    registry: Any,
    agent_store: Any,
    placement_store: Any,
) -> dict[str, Any] | None:
    executor_kind = valid_agent(task.get("assignedAgent"))
    if not executor_kind or task.get("assignedAgentId"):
        return None
    assignment = materialize_legacy_agent_assignment(
        task,
        executor_kind,
        registry=registry,
        agent_store=agent_store,
        placement_store=placement_store,
    )
    if not assignment:
        return None
    return task_store.set_task_assignment(
        task["id"], executor_kind, assignment["agentId"]
    )


def ready_node_for_task(
    registry: Any, task: dict[str, Any], assignments: list[dict[str, Any]]
) -> dict[str, Any] | None:
    if not assignments:
        return None
    requested_agents = [
        assignment.get("agent") for assignment in assignments if assignment.get("agent")
    ]
    user_id = task.get("assigneeUserId") or task.get("ownerUserId")
    active_runs_by_node: dict[str, list[dict[str, Any]]] = {}
    for run in registry.daemon_store.list_active_runs():
        active_runs_by_node.setdefault(run["nodeId"], []).append(run)
    for node in registry.list_ready():
        if user_id and node.get("userId") != user_id:
            continue
        if node.get("status") in (
            "stopped",
            "failed",
            "provisioning",
        ) or not registry.is_dispatchable(node["id"]):
            continue
        disabled = set(node.get("disabledAgents") or [])
        if any(agent in disabled for agent in requested_agents):
            continue
        active_runs = active_runs_by_node.get(node["id"], [])
        if all(
            node.get("agents", {}).get(agent) == "ready" for agent in requested_agents
        ) and node_accepts_run(
            node,
            active_runs=active_runs,
        ):
            return node
    return None


def user_has_device_node(registry: Any, user_id: str) -> bool:
    return any(
        node.get("userId") == user_id
        and node.get("nodeLocation") == "user-device"
        and not node.get("retiredAt")
        for node in registry.monitor_nodes()
    )


def ensure_managed_capacity_for_task(
    task: dict[str, Any], registry: Any, managed_node_store: Any | None
) -> Any | None:
    if not managed_node_store:
        return None
    user_id = task.get("assigneeUserId") or task.get("ownerUserId")
    if not user_id or user_has_device_node(registry, user_id):
        return None
    return managed_node_store.ensure_node_for_user(user_id)
