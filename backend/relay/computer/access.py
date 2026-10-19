"""Who may change a computer.

A user's personal computer (``nodeLocation: "user-device"`` with an owner) is
theirs alone: an admin sees it in the console but cannot rename, reconfigure,
reassign, refresh, or delete it — only its owner can, from their own Computers
page. Admin-provisioned hardware (managed or unassigned) stays the admin's to
manage. This is the one seam every computer-mutating route asks.
"""

from __future__ import annotations

from typing import Any

from ..security.actor import Actor

PERSONAL_COMPUTER_READ_ONLY = "This is a user's own computer; only its owner can change it."


def is_personal_computer(node: dict[str, Any]) -> bool:
    return node.get("nodeLocation") == "user-device" and bool(node.get("userId"))


def admin_may_manage_computer(node: dict[str, Any]) -> bool:
    """Whether the admin console may act on a computer it does not own."""
    return not is_personal_computer(node)


def actor_may_manage_computer(actor: Actor, node: dict[str, Any]) -> bool:
    if node.get("userId") == actor["userId"]:
        return True
    return actor["isAdmin"] and admin_may_manage_computer(node)
