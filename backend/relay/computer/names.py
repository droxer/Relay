from __future__ import annotations

import unicodedata
from typing import Any, Protocol

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
    return (
        (managed_node or {}).get("displayName") or node.get("displayName") or node["id"]
    )


def present_computer(ctx: ComputerContext, node: dict[str, Any]) -> dict[str, Any]:
    return {**node, "displayName": computer_display_name(ctx, node)}


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
