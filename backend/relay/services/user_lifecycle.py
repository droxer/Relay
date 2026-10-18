"""User soft-delete and the cascade it owns.

Deleting a user touches five stores: the auth store marks the user
deleted, the registry unassigns their nodes, their agents are deleted, their
placements removed, their team memberships dropped, and their managed nodes
marked for teardown. Each store used to commit that on its own, so a failure
part-way through left a deleted user still owning live agents, placements,
and nodes, with no way to finish or undo the rest.

Now the durable work runs in one transaction on the shared engine. The registry
also keeps nodes in memory, which a database rollback cannot undo, so the
affected entries are snapshotted and restored if the transaction fails.
"""

from __future__ import annotations

from contextlib import nullcontext
from typing import Any

from loguru import logger

from ..persistence.store_common import store_transaction
from .team_membership import remove_agent_from_teams

CASCADE_STORES = (
    "auth_store",
    "agent_store",
    "agent_placement_store",
    "team_store",
)


def cascade_engine(ctx: Any) -> Any | None:
    """The engine shared by every store in the cascade.

    Returns None when no participant has an engine (a test double) or they
    point at different databases.
    """
    participants = [getattr(ctx, name, None) for name in CASCADE_STORES]
    participants.append(getattr(getattr(ctx, "registry", None), "daemon_store", None))
    engines = [
        engine
        for store in participants
        if (engine := getattr(store, "engine", None)) is not None
    ]
    if not engines:
        return None
    first = engines[0]
    return first if all(engine is first for engine in engines) else None


def soft_delete_user(ctx: Any, user_id: str) -> dict[str, Any]:
    """Soft-delete a user and everything that hangs off them.

    Raises KeyError if the user does not exist and ValueError if they are
    already deleted, matching the auth store's own contract.
    """
    engine = cascade_engine(ctx)
    scope = store_transaction(engine) if engine is not None else nullcontext()
    registry = getattr(ctx, "registry", None)
    managed_nodes = _user_managed_nodes(ctx, user_id)
    registry_node_ids = _registry_node_ids(registry, user_id, managed_nodes)
    registry_scope = (
        registry.dispatch_scope(registry_node_ids)
        if registry is not None and hasattr(registry, "dispatch_scope")
        else nullcontext()
    )

    with registry_scope:
        restore = _registry_snapshot(registry, registry_node_ids)
        try:
            with scope:
                return _cascade(ctx, user_id, managed_nodes)
        except Exception:
            _restore_registry(registry, restore)
            raise


def _cascade(
    ctx: Any, user_id: str, managed_nodes: list[dict[str, Any]]
) -> dict[str, Any]:
    project_store = getattr(ctx, "project_store", None)
    if project_store and project_store.list_projects(
        user_id, include_archived=False
    ):
        # Project ownership is durable product state. Deleting the user
        # first would orphan the project and delete the roster agents it still
        # references, so require an explicit archive before cascading.
        raise ValueError("user_has_projects")
    record = ctx.auth_store.soft_delete_user(user_id)
    affected_nodes = ctx.registry.unassign_user_everywhere(user_id)

    removed_placements: list[str] = []
    deleted_agents: list[str] = []
    for agent in ctx.agent_store.list_agents(supervisor_user_id=user_id):
        for placement in ctx.agent_placement_store.list_placements(
            agent_id=agent["id"]
        ):
            removed = ctx.agent_placement_store.update_placement(
                placement["id"], {"desiredState": "removed"}
            )
            removed_placements.append(removed["id"])
        deleted = ctx.agent_store.delete_agent(agent["id"])
        remove_agent_from_teams(ctx.team_store, agent["id"], user_id)
        deleted_agents.append(deleted["id"])

    deleted_managed_nodes: list[str] = []
    for node in managed_nodes:
        deleted = ctx.managed_node_store.update_node(
            node["id"], {"desiredState": "deleted"}
        )
        daemon_node_id = deleted.get("activeDaemonNodeId")
        if daemon_node_id and ctx.registry.get(daemon_node_id):
            ctx.registry.fence_managed_node(daemon_node_id)
        deleted_managed_nodes.append(deleted["id"])

    return {
        "user": record,
        "unassignedNodes": affected_nodes,
        "deletedAgents": deleted_agents,
        "removedPlacements": removed_placements,
        "deletedManagedNodes": deleted_managed_nodes,
    }


def _user_managed_nodes(ctx: Any, user_id: str) -> list[dict[str, Any]]:
    managed_node_store = getattr(ctx, "managed_node_store", None)
    if managed_node_store is None:
        return []
    return [
        node
        for node in managed_node_store.list_nodes()
        if node.get("userId") == user_id
    ]


def _registry_node_ids(
    registry: Any,
    user_id: str,
    managed_nodes: list[dict[str, Any]],
) -> list[str]:
    sandboxes = getattr(registry, "sandboxes", {})
    node_ids = {
        node_id
        for node_id, node in sandboxes.items()
        if node.get("userId") == user_id
    }
    node_ids.update(
        node["activeDaemonNodeId"]
        for node in managed_nodes
        if node.get("activeDaemonNodeId")
    )
    return sorted(node_ids)


def _registry_snapshot(
    registry: Any, node_ids: list[str]
) -> dict[str, dict[str, Any]] | None:
    sandboxes = getattr(registry, "sandboxes", None)
    if sandboxes is None:
        return None
    return {
        node_id: dict(sandboxes[node_id])
        for node_id in node_ids
        if node_id in sandboxes
    }


def _restore_registry(
    registry: Any, snapshot: dict[str, dict[str, Any]] | None
) -> None:
    if snapshot is None:
        return
    sandboxes = getattr(registry, "sandboxes", None)
    if sandboxes is None:
        return
    for node_id, node in snapshot.items():
        sandboxes[node_id] = node
    logger.warning("Restored in-memory daemon nodes after a failed user delete")
