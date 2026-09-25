"""A team lives on one computer.

Team dispatch is a lead-first pipeline across every member in one shared
workspace, so a roster split across machines can never take a thread. Team
setup therefore picks the computer first and draws the roster from the agents
on it; this module is the backend half of that rule, mirroring what
`validate_project_roster` does for a project's crew.
"""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any

from ..core.computer_identity import computer_id
from ..persistence.team_store import TeamValidationError


def placement_on_computer(
    placement: Mapping[str, Any],
    target_computer_id: str,
    target_node_id: str | None,
) -> bool:
    """Is this placement an active one on the target computer?

    Legacy placements predate stable computer ids and only name the daemon
    node, so they match on the node currently hosting the computer.
    """
    if placement.get("desiredState") != "active":
        return False
    if placement.get("computerId"):
        return placement["computerId"] == target_computer_id
    return target_node_id is not None and placement.get("daemonNodeId") == target_node_id


def _agent_computer_ids(agent: Mapping[str, Any], registry: Any, placement_store: Any) -> set[str]:
    """The computers an agent actually runs on: its active placements, or the
    computer it was created on when nothing has been placed yet."""
    found: set[str] = set()
    for placement in placement_store.list_placements(agent_id=agent["id"]):
        if placement.get("desiredState") != "active":
            continue
        if placement.get("computerId"):
            found.add(placement["computerId"])
            continue
        node = registry.get(placement.get("daemonNodeId") or "")
        if node:
            found.add(computer_id(node))
    if not found and agent.get("computerId"):
        found.add(agent["computerId"])
    return found


def _named_computer(owner_employee_id: str, value: Any, registry: Any) -> str:
    """Validate the computer a team write names.

    Matched by stable computer id and owner together, as agent creation does:
    naming another employee's computer id must not pass.
    """
    if not isinstance(value, str) or not value.strip():
        raise TeamValidationError("team_computer_required")
    target = value.strip()
    nodes = [
        node
        for node in registry.monitor_nodes()
        if computer_id(node) == target
        and not node.get("retiredAt")
        and node.get("status") != "deleted"
    ]
    if not nodes:
        raise TeamValidationError("team_computer_not_found")
    if not any(node.get("employeeId") == owner_employee_id for node in nodes):
        raise TeamValidationError("team_computer_forbidden")
    return target


def resolve_team_computer(
    owner_employee_id: str,
    body: Mapping[str, Any],
    member_ids: list[str],
    *,
    current: Mapping[str, Any] | None,
    registry: Any,
    agent_store: Any,
    placement_store: Any,
) -> str | None:
    """Return the computer the team lives on after this write, or None when the
    write changes neither who is on the roster nor the computer.

    The computer is the one the write names, else the team's recorded
    one, else — for a caller that never names one — the single computer
    hosting the whole roster. Every member must be on it.
    """
    names_computer = "computerId" in body
    # Clients resend the stored roster with every save; only a change in who
    # is on the team (order is not placement) can move it off its computer.
    roster_changed = current is None or set(member_ids) != set(
        current.get("memberAgentIds") or []
    )
    if not names_computer and not roster_changed:
        return None
    target = (
        _named_computer(owner_employee_id, body.get("computerId"), registry)
        if names_computer
        else (current or {}).get("computerId")
    )
    rosters = [
        _agent_computer_ids(agent_store.get_agent(agent_id) or {"id": agent_id}, registry, placement_store)
        for agent_id in member_ids
    ]
    if target:
        if any(target not in computers for computers in rosters):
            raise TeamValidationError("team_member_computer_mismatch")
        return target
    shared = set.intersection(*rosters) if rosters else set()
    if not shared:
        raise TeamValidationError("team_member_computer_mismatch")
    # Several shared computers is legal but ambiguous; sorting keeps the
    # choice stable across retries of the same write.
    return sorted(shared)[0]
