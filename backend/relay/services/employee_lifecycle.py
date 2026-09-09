"""Employee soft-delete and the cascade it owns.

Deleting an employee touches five stores: the auth store marks the employee
deleted, the registry unassigns their nodes, their agents are deleted, their
placements removed, their team memberships dropped, and their managed nodes
marked for teardown. Each store used to commit that on its own, so a failure
part-way through left a deleted employee still owning live agents, placements,
and nodes, with no way to finish or undo the rest.

Now the durable work runs in one transaction on the shared engine. The registry
also keeps nodes in memory, which a database rollback cannot undo, so the
affected entries are snapshotted and restored if the transaction fails.
"""

from __future__ import annotations

import shutil
from contextlib import ExitStack, contextmanager, nullcontext
from pathlib import Path
from tempfile import TemporaryDirectory
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
    """The engine shared by every store in the cascade, if there is one.

    Returns None when any participant is file-backed or points at a different
    database -- there is no transaction to join, so the cascade behaves as it
    did before.
    """
    engines = []
    for name in CASCADE_STORES:
        engine = getattr(getattr(ctx, name, None), "engine", None)
        if engine is None:
            return None
        engines.append(engine)
    registry_store = getattr(getattr(ctx, "registry", None), "daemon_store", None)
    daemon_engine = getattr(registry_store, "engine", None)
    if daemon_engine is None:
        return None
    engines.append(daemon_engine)

    first = engines[0]
    return first if all(engine is first for engine in engines) else None


def soft_delete_employee(ctx: Any, employee_id: str) -> dict[str, Any]:
    """Soft-delete an employee and everything that hangs off them.

    Raises KeyError if the employee does not exist and ValueError if they are
    already deleted, matching the auth store's own contract.
    """
    engine = cascade_engine(ctx)
    scope = store_transaction(engine) if engine is not None else nullcontext()
    registry = getattr(ctx, "registry", None)
    managed_nodes = _employee_managed_nodes(ctx, employee_id)
    registry_node_ids = _registry_node_ids(registry, employee_id, managed_nodes)
    registry_scope = (
        registry.dispatch_scope(registry_node_ids)
        if registry is not None and hasattr(registry, "dispatch_scope")
        else nullcontext()
    )

    with registry_scope:
        restore = _registry_snapshot(registry, registry_node_ids)
        try:
            with local_store_rollback(ctx), scope:
                return _cascade(ctx, employee_id, managed_nodes)
        except Exception:
            _restore_registry(registry, restore)
            raise


@contextmanager
def local_store_rollback(ctx: Any):
    """Restore file-backed cascade participants when a later write fails.

    Database stores join ``store_transaction`` above. Local stores expose no
    transaction API, so their durable directories are snapshotted while their
    in-process locks are held and restored as one unit on failure.
    """
    stores = [
        getattr(ctx, "auth_store", None),
        getattr(ctx, "agent_store", None),
        getattr(ctx, "agent_placement_store", None),
        getattr(ctx, "team_store", None),
        getattr(ctx, "managed_node_store", None),
        getattr(getattr(ctx, "registry", None), "daemon_store", None),
    ]
    local_stores = [
        store
        for store in stores
        if store is not None and getattr(store, "engine", None) is None
    ]
    paths = _local_store_paths(local_stores)
    if not paths:
        yield
        return

    with ExitStack() as stack, TemporaryDirectory(prefix="relay-delete-") as temp:
        locks = sorted(
            {
                id(lock): lock
                for store in local_stores
                if (lock := getattr(store, "_lock", None))
            }.values(),
            key=id,
        )
        for lock in locks:
            stack.enter_context(lock)
        backup_root = Path(temp)
        snapshots: list[tuple[Path, Path, bool]] = []
        for index, path in enumerate(paths):
            backup = backup_root / str(index)
            existed = path.exists()
            if existed:
                if path.is_dir():
                    shutil.copytree(path, backup)
                else:
                    shutil.copy2(path, backup)
            snapshots.append((path, backup, existed))
        try:
            yield
        except Exception:
            for path, backup, existed in snapshots:
                if path.exists():
                    if path.is_dir():
                        shutil.rmtree(path)
                    else:
                        path.unlink()
                if existed:
                    if backup.is_dir():
                        shutil.copytree(backup, path)
                    else:
                        path.parent.mkdir(parents=True, exist_ok=True)
                        shutil.copy2(backup, path)
            logger.warning("Restored file-backed stores after a failed employee delete")
            raise


def _local_store_paths(stores: list[Any]) -> list[Path]:
    paths: set[Path] = set()
    for store in stores:
        candidate = None
        if hasattr(store, "deleted_employees_path"):
            candidate = store.deleted_employees_path
        elif hasattr(store, "root"):
            candidate = store.root
        elif hasattr(store, "nodes_dir"):
            candidate = store.nodes_dir.parent
        if candidate is not None:
            paths.add(Path(candidate))
    return sorted(paths, key=lambda path: str(path.resolve()))


def _cascade(
    ctx: Any, employee_id: str, managed_nodes: list[dict[str, Any]]
) -> dict[str, Any]:
    project_store = getattr(ctx, "project_store", None)
    if project_store and project_store.list_projects(
        employee_id, include_archived=False
    ):
        # Project ownership is durable product state. Deleting the employee
        # first would orphan the project and delete the roster agents it still
        # references, so require an explicit archive before cascading.
        raise ValueError("employee_has_projects")
    record = ctx.auth_store.soft_delete_employee(employee_id)
    affected_nodes = ctx.registry.unassign_employee_everywhere(employee_id)

    removed_placements: list[str] = []
    deleted_agents: list[str] = []
    for agent in ctx.agent_store.list_agents(supervisor_employee_id=employee_id):
        for placement in ctx.agent_placement_store.list_placements(
            agent_id=agent["id"]
        ):
            removed = ctx.agent_placement_store.update_placement(
                placement["id"], {"desiredState": "removed"}
            )
            removed_placements.append(removed["id"])
        deleted = ctx.agent_store.delete_agent(agent["id"])
        remove_agent_from_teams(ctx.team_store, agent["id"], employee_id)
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
        "employee": record,
        "unassignedNodes": affected_nodes,
        "deletedAgents": deleted_agents,
        "removedPlacements": removed_placements,
        "deletedManagedNodes": deleted_managed_nodes,
    }


def _employee_managed_nodes(ctx: Any, employee_id: str) -> list[dict[str, Any]]:
    managed_node_store = getattr(ctx, "managed_node_store", None)
    if managed_node_store is None:
        return []
    return [
        node
        for node in managed_node_store.list_nodes()
        if node.get("employeeId") == employee_id
    ]


def _registry_node_ids(
    registry: Any,
    employee_id: str,
    managed_nodes: list[dict[str, Any]],
) -> list[str]:
    sandboxes = getattr(registry, "sandboxes", {})
    node_ids = {
        node_id
        for node_id, node in sandboxes.items()
        if node.get("employeeId") == employee_id
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
    logger.warning("Restored in-memory daemon nodes after a failed employee delete")
