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
from .agent_location import agent_computer_ids


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
    nodes_by_id = {node["id"]: node for node in registry.monitor_nodes()}
    rosters = [
        agent_computer_ids(
            {**(agent_store.get_agent(agent_id) or {}), "id": agent_id},
            placement_store=placement_store,
            nodes_by_id=nodes_by_id,
        )
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
