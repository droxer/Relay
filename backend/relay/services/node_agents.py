from __future__ import annotations

from typing import Any, Protocol

from loguru import logger

from ..core.computer_identity import computer_id, is_provisional_computer_id
from ..core.node_readiness import ready_runtimes
from ..persistence.agent_placement_store import create_node_placement
from ..persistence.protocols import (
    AgentPlacementStore,
    AgentStore,
    ProjectStore,
    TeamStore,
)
from .project_catalog import agent_has_active_project
from .team_membership import remove_agent_from_teams


class NodeAgentRegistry(Protocol):
    daemon_store: Any
    dispatch_lock: Any

    def monitor_nodes(self) -> list[dict[str, Any]]: ...


class NodeAgentContext(Protocol):
    registry: NodeAgentRegistry
    agent_store: AgentStore
    agent_placement_store: AgentPlacementStore
    team_store: TeamStore
    project_store: ProjectStore


def assert_node_agent_runs_drained(ctx: NodeAgentContext, node_id: str) -> None:
    registry = getattr(ctx, "registry", None)
    daemon_store = getattr(registry, "daemon_store", None)
    if not daemon_store:
        return
    if any(
        request.get("nodeId") == node_id
        or any(
            assignment.get("daemonNodeId") == node_id
            for assignment in request.get("assignments") or []
        )
        for request in daemon_store.list_active_run_requests()
    ):
        raise ValueError(
            "Daemon node has active agent work. Wait for its runs to finish before "
            "deleting it."
        )


def employee_is_live(ctx: NodeAgentContext, employee_id: str) -> bool:
    """Whether the employee exists and has not been soft-deleted.

    `employees.deleted_at` only filters listings, so without this check a node
    that keeps registering would backfill placements for an employee's
    already-declared agents even after that employee (and their agents) were
    just deleted.

    `auth_store` is not part of NodeAgentContext, so it is read defensively —
    test doubles and reduced contexts may not carry one.
    """
    auth_store = getattr(ctx, "auth_store", None)
    if auth_store is None:
        return True
    if hasattr(auth_store, "list_employees"):
        # list_employees already excludes soft-deleted rows.
        return any(
            employee.get("id") == employee_id
            for employee in auth_store.list_employees()
        )
    if hasattr(auth_store, "deleted_employee_ids"):
        return employee_id not in auth_store.deleted_employee_ids()
    return True


def sync_node_agents(ctx: NodeAgentContext, node: dict[str, Any]) -> None:
    """Attach this Computer's already-declared agents to its current node.

    Does not create agents — agents are declared explicitly by employees
    (POST /agents). An employee can declare an agent while its computer is
    offline, when there's no node to place it on yet; this backfills that
    once the computer comes online.
    """
    employee_id = node.get("employeeId")
    if not employee_id:
        return
    if not employee_is_live(ctx, employee_id):
        logger.info(
            "Skipping agent sync for a deleted employee",
            node_id=node.get("id"),
            employee_id=employee_id,
        )
        return
    node_computer_id = computer_id(node)
    available = ready_runtimes([node])
    try:
        owned = ctx.agent_store.list_agents(supervisor_employee_id=employee_id)
    except Exception as error:
        if _missing_agent_table(error):
            logger.warning(
                "Skipping agent sync during rolling upgrade",
                node_id=node.get("id"),
                error=str(error),
            )
            return
        raise
    for agent in owned:
        if agent.get("deletedAt"):
            continue
        if agent["executorKind"] not in available:
            continue
        placements = ctx.agent_placement_store.list_placements(agent_id=agent["id"])
        agent_computer_id = agent.get("computerId")
        if agent_computer_id != node_computer_id:
            can_promote = (
                not is_provisional_computer_id(node_computer_id)
                and (
                    not agent_computer_id
                    or is_provisional_computer_id(agent_computer_id)
                )
                and any(
                    placement.get("daemonNodeId") == node["id"]
                    for placement in placements
                )
            )
            if not can_promote:
                continue
            agent = ctx.agent_store.set_birth_certificate(
                agent["id"],
                computer_id=node_computer_id,
                default_role=agent.get("defaultRole") or "implementer",
            )
        if any(
            placement.get("computerId") == node_computer_id
            for placement in placements
        ):
            continue
        legacy = next(
            (
                placement
                for placement in placements
                if not placement.get("computerId")
                or is_provisional_computer_id(placement.get("computerId"))
            ),
            None,
        )
        if legacy:
            ctx.agent_placement_store.rebind_placement(
                legacy["id"],
                node["id"],
                managed_node_id=node.get("managedNodeId"),
                computer_id_value=node_computer_id,
            )
            continue
        if placements:
            continue
        create_node_placement(ctx.agent_placement_store, agent, node)


def _missing_agent_table(error: Exception) -> bool:
    message = str(error)
    return "no such table" in message or "does not exist" in message


def _managed_runtime_ids(ctx: NodeAgentContext, managed_node_id: str) -> set[str]:
    registry = getattr(ctx, "registry", None)
    if not registry:
        return set()
    runtime_ids = {
        runtime["id"]
        for runtime in registry.monitor_nodes()
        if runtime.get("managedNodeId") == managed_node_id
    }
    daemon_store = getattr(registry, "daemon_store", None)
    historical_runtime_ids = getattr(
        daemon_store, "historical_managed_runtime_ids", None
    )
    if historical_runtime_ids:
        runtime_ids.update(historical_runtime_ids(managed_node_id))
    return runtime_ids


def retire_superseded_compatibility_agents(
    ctx: NodeAgentContext,
    node: dict[str, Any],
    employee_id: str,
    executor_kind: str,
) -> list[str]:
    """Retire duplicate compatibility agents left behind when this computer
    re-registered under a new node id.

    Re-provisioning a computer mints a new node id, and the compatibility key
    embeds it, so the old agent would linger in the roster next to its
    replacement. Only retire when the other node is provably the same computer
    (same managed node, or — for employee devices — the same stable Computer
    identity) and is no longer online, so a legitimately separate second
    computer always keeps its agents.

    Also retires legacy compatibility agents keyed by the pre-node-scoped
    ``<employee>:<kind>`` format (two segments, no node id) once a node-scoped
    sibling is placed on the same computer. Those legacy keys predate the
    ``<employee>:<node>:<kind>`` scheme and are otherwise immortal — the
    superseded-node logic below only understands three-segment keys — so they
    would sit on the roster forever next to their node-scoped replacement.
    """
    registry = getattr(ctx, "registry", None)
    if registry is None:
        return []
    nodes_by_id = {item["id"]: item for item in registry.monitor_nodes()}
    managed_node_id = node.get("managedNodeId")
    managed_runtime_ids = (
        _managed_runtime_ids(ctx, managed_node_id) if managed_node_id else set()
    )
    computer_scoped_key = _compatibility_key_for(
        employee_id, computer_id(node), executor_kind
    )
    has_computer_scoped_sibling = any(
        agent.get("compatibilityKey") == computer_scoped_key
        and not agent.get("deletedAt")
        for agent in ctx.agent_store.list_agents(supervisor_employee_id=employee_id)
    )
    retired: list[str] = []
    for agent in ctx.agent_store.list_agents(supervisor_employee_id=employee_id):
        key = agent.get("compatibilityKey")
        if not key or agent.get("deletedAt"):
            continue
        if key == computer_scoped_key:
            continue
        parts = key.rsplit(":", 2)
        if len(parts) == 2:
            owner, kind = parts
            if (
                owner != employee_id
                or kind != executor_kind
                or not has_computer_scoped_sibling
                or _node_has_active_work(ctx, node["id"])
                or not _agent_placed_on_node(ctx, agent["id"], node["id"])
            ):
                continue
            if _retire_compatibility_agent(ctx, agent, employee_id):
                retired.append(agent["id"])
                logger.info(
                    "Retired legacy compatibility agent",
                    agent_id=agent["id"],
                    superseded_by=node["id"],
                    legacy_key=key,
                    executor_kind=executor_kind,
                )
            continue
        if len(parts) != 3:
            continue
        owner, node_id, kind = parts
        if owner != employee_id or kind != executor_kind or node_id == node["id"]:
            continue
        other = nodes_by_id.get(node_id)
        if other is None:
            if (
                not managed_node_id
                or node_id not in managed_runtime_ids
                or _node_has_active_work(ctx, node_id)
            ):
                continue
            if _retire_compatibility_agent(ctx, agent, employee_id):
                retired.append(agent["id"])
                logger.info(
                    "Retired orphaned managed compatibility agent",
                    agent_id=agent["id"],
                    superseded_by=node["id"],
                    old_node_id=node_id,
                    executor_kind=executor_kind,
                )
            continue
        if other.get("online"):
            continue
        if node.get("managedNodeId") or other.get("managedNodeId"):
            same_computer = bool(node.get("managedNodeId")) and node.get(
                "managedNodeId"
            ) == other.get("managedNodeId")
        else:
            same_computer = computer_id(node) == computer_id(other)
        if not same_computer or _node_has_active_work(ctx, node_id):
            continue
        if _retire_compatibility_agent(ctx, agent, employee_id):
            retired.append(agent["id"])
            logger.info(
                "Retired superseded compatibility agent",
                agent_id=agent["id"],
                superseded_by=node["id"],
                old_node_id=node_id,
                executor_kind=executor_kind,
            )
    return retired


def _compatibility_key_for(employee_id: str, node_id: str, executor_kind: str) -> str:
    return f"{employee_id}:{node_id}:{executor_kind}"


def _agent_placed_on_node(ctx: NodeAgentContext, agent_id: str, node_id: str) -> bool:
    return any(
        placement.get("daemonNodeId") == node_id
        for placement in ctx.agent_placement_store.list_placements(agent_id=agent_id)
    )


def _retire_compatibility_agent(
    ctx: NodeAgentContext, agent: dict[str, Any], employee_id: str
) -> bool:
    """Remove an agent's live placements and delete it once it holds none.

    Returns False without deleting when the agent still has an active placement
    on another computer, so a compatibility agent shared across nodes survives.
    """
    for placement in ctx.agent_placement_store.list_placements(agent_id=agent["id"]):
        if placement.get("desiredState") != "removed":
            ctx.agent_placement_store.update_placement(
                placement["id"], {"desiredState": "removed"}
            )
    if ctx.agent_placement_store.list_placements(agent_id=agent["id"]):
        return False
    if getattr(ctx, "project_store", None) and agent_has_active_project(
        ctx.project_store, agent["id"]
    ):
        return False
    ctx.agent_store.delete_agent(agent["id"])
    if getattr(ctx, "team_store", None):
        remove_agent_from_teams(ctx.team_store, agent["id"], employee_id)
    return True


def _node_has_active_work(ctx: NodeAgentContext, node_id: str) -> bool:
    daemon_store = getattr(getattr(ctx, "registry", None), "daemon_store", None)
    if not daemon_store:
        return False
    return any(
        request.get("nodeId") == node_id
        or any(
            assignment.get("daemonNodeId") == node_id
            for assignment in request.get("assignments") or []
        )
        for request in daemon_store.list_active_run_requests()
    )


def remove_node_agents(ctx: NodeAgentContext, node_id: str) -> list[str]:
    """Remove a deleted node's placements, under the dispatch lifecycle lock.

    Does not delete the agents themselves — only the placements pinned to
    this node. Agents stay on the roster and can only be deleted by the
    employee who declared them; see `_remove_node_agents_locked`.
    """
    registry = getattr(ctx, "registry", None)
    dispatch_lock = getattr(registry, "dispatch_lock", None)
    if dispatch_lock:
        with dispatch_lock:
            return _remove_node_agents_locked(ctx, node_id)
    return _remove_node_agents_locked(ctx, node_id)


def _remove_node_agents_locked(ctx: NodeAgentContext, node_id: str) -> list[str]:
    """Remove placements on a deleted computer.

    Agents are declared explicitly by employees and can only be deleted by
    employees. Once the computer is gone, binding_status marks the agent
    computer_gone and it stays on the roster — the system never erases it.
    Legacy compatibility agents (identified by compatibilityKey) are the
    exception: they were an internal migration bridge, not an employee-owned
    identity, and are retired when their last placement disappears.
    """
    assert_node_agent_runs_drained(ctx, node_id)
    orphaned_agents: list[str] = []
    seen: set[str] = set()
    try:
        placements = ctx.agent_placement_store.list_placements(
            daemon_node_id=node_id, include_removed=True
        )
    except Exception as error:
        if "no such table" in str(error) or "does not exist" in str(error):
            logger.warning(
                "Skipping agent removal during rolling upgrade",
                node_id=node_id,
                error=str(error),
            )
            return orphaned_agents
        raise
    for placement in placements:
        if placement.get("desiredState") != "removed":
            ctx.agent_placement_store.update_placement(
                placement["id"], {"desiredState": "removed"}
            )
        agent_id = placement.get("agentId")
        if not agent_id or agent_id in seen:
            continue
        seen.add(agent_id)
        agent = ctx.agent_store.get_agent(agent_id)
        active_elsewhere = ctx.agent_placement_store.list_placements(agent_id=agent_id)
        if not agent or agent.get("deletedAt") or active_elsewhere:
            continue
        if not agent.get("compatibilityKey"):
            # Employee-declared agents are never auto-deleted; the computer
            # going away just leaves them unplaced (binding_status flags
            # computer_gone). Report them so callers can log/notify.
            orphaned_agents.append(agent_id)
            continue
        if getattr(ctx, "project_store", None) and agent_has_active_project(
            ctx.project_store, agent_id
        ):
            continue
        ctx.agent_store.delete_agent(agent_id)
        if getattr(ctx, "team_store", None):
            remove_agent_from_teams(
                ctx.team_store, agent_id, agent["supervisorEmployeeId"]
            )
        orphaned_agents.append(agent_id)
    return orphaned_agents
