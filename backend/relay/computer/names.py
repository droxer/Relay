from __future__ import annotations

import unicodedata
from typing import Any, Protocol

from ..core.managed_node_policy import managed_node_placeholder
from ..persistence.protocols import ManagedNodeStore
from ..security.actor import Actor
from .access import actor_may_manage_computer

MAX_COMPUTER_DISPLAY_NAME_LENGTH = 64


class ComputerRegistry(Protocol):
    def get(self, node_id: str) -> dict[str, Any] | None: ...
    def set_display_name(
        self, node_id: str, display_name: str | None
    ) -> dict[str, Any]: ...


class ComputerContext(Protocol):
    @property
    def registry(self) -> ComputerRegistry: ...
    @property
    def managed_node_store(self) -> ManagedNodeStore: ...


def normalize_computer_display_name(value: Any) -> str | None:
    if value is None:
        return None
    if not isinstance(value, str):
        raise ValueError("displayName must be a string or null.")
    display_name = value.strip()
    if not display_name:
        raise ValueError("displayName must not be blank.")
    if len(display_name) > MAX_COMPUTER_DISPLAY_NAME_LENGTH:
        raise ValueError(
            f"displayName must be at most {MAX_COMPUTER_DISPLAY_NAME_LENGTH} characters."
        )
    if any(unicodedata.category(character) == "Cc" for character in display_name):
        raise ValueError("displayName must not contain control characters.")
    return display_name


def computer_display_name(ctx: ComputerContext, node: dict[str, Any]) -> str:
    managed_node = (
        ctx.managed_node_store.get_node(node["managedNodeId"])
        if node.get("managedNodeId")
        else None
    )
    return _display_name(node, managed_node)


def _display_name(node: dict[str, Any], managed_node: dict[str, Any] | None) -> str:
    return (managed_node or {}).get("displayName") or node.get("displayName") or node["id"]


def present_computer(ctx: ComputerContext, node: dict[str, Any]) -> dict[str, Any]:
    return {**node, "displayName": computer_display_name(ctx, node)}


def present_computer_inventory(
    ctx: ComputerContext,
    nodes: list[dict[str, Any]],
    *,
    owner_user_id: str | None = None,
    managed_ids: set[str] | None = None,
) -> list[dict[str, Any]]:
    """Use one managed-node read for names, tombstones, and pending Computers."""
    if owner_user_id is not None or managed_ids is not None:
        # Keep names and tombstones for visible runtimes even if the desired
        # state changed owner before the runtime's record caught up.
        observed_ids = {node["managedNodeId"] for node in nodes if node.get("managedNodeId")}
        records = ctx.managed_node_store.list_nodes(
            include_deleted=True, user_id=owner_user_id, include_ids=observed_ids | (managed_ids or set()),
        )
    else:
        records = ctx.managed_node_store.list_nodes(include_deleted=True)
    managed_nodes = {node["id"]: node for node in records}
    observed = []
    observed_managed_ids = set()
    for node in nodes:
        if node.get("retiredAt"):
            continue
        managed_id = node.get("managedNodeId")
        managed = managed_nodes.get(managed_id) if managed_id else None
        if managed and managed.get("desiredState") == "deleted":
            continue
        observed.append({**node, "displayName": _display_name(node, managed)})
        if managed_id:
            observed_managed_ids.add(managed_id)
    return [
        *observed,
        *(
            managed_node_placeholder(node)
            for node_id, node in managed_nodes.items()
            if node.get("desiredState") != "deleted"
            and node_id not in observed_managed_ids
            and (owner_user_id is None or node.get("userId") == owner_user_id)
            and (managed_ids is None or node_id in managed_ids)
        ),
    ]


def rename_computer_for_actor(
    ctx: ComputerContext,
    actor: Actor,
    node_id: str,
    requested_display_name: Any,
) -> dict[str, Any]:
    node = ctx.registry.get(node_id)
    if not node:
        raise KeyError(node_id)
    if not actor_may_manage_computer(actor, node):
        raise PermissionError(node_id)

    display_name = normalize_computer_display_name(requested_display_name)
    managed_node_id = node.get("managedNodeId")
    if managed_node_id:
        ctx.managed_node_store.update_node(
            managed_node_id, {"displayName": display_name or managed_node_id}
        )
        updated = node
    else:
        updated = ctx.registry.set_display_name(node_id, display_name)
    return present_computer(ctx, updated)
