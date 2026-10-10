"""Where an agent lives: the one seam for "is this agent on that computer?".

An agent belongs to exactly one computer, recorded on the agent as its
``computerId`` birth certificate. Placements bind it to the daemon node that
currently realizes that computer; a computer can have several node records
across reprovisioning, so a placement is a runtime binding, not identity.

Two questions, deliberately kept apart:

- ``agent_computer_ids`` — where the agent *lives*. Team rosters and thread
  mentions ask this; an agent whose computer is offline still lives there.
- ``agent_placed_on_computer`` — whether it is *ready* there, i.e. holds an
  active placement. Project roster admission asks this.
"""

from __future__ import annotations

from collections.abc import Mapping, Set
from typing import Any

from ..core.computer_identity import computer_id, is_provisional_computer_id
from ..persistence.agent_placement_store import create_node_placement

LIVE_PLACEMENT_STATES = frozenset({"active", "draining"})


class AgentMoveError(ValueError):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code


def agent_computer_ids(
    agent: Mapping[str, Any],
    *,
    placement_store: Any,
    nodes_by_id: Mapping[str, Mapping[str, Any]],
) -> set[str]:
    """The computer an agent lives on.

    A durable birth certificate answers outright. Only legacy agents — no
    certificate, or a provisional ``node:`` one that migration has not yet
    repaired — fall back to their live placements, which may then name more
    than one computer.
    """
    birth = agent.get("computerId")
    if birth and not is_provisional_computer_id(birth):
        return {birth}
    found: set[str] = set()
    for placement in placement_store.list_placements(agent_id=agent["id"]):
        if placement.get("desiredState") not in LIVE_PLACEMENT_STATES:
            continue
        located = _placement_computer_id(placement, nodes_by_id)
        if located:
            found.add(located)
    if not found and birth:
        found.add(birth)
    return found


def agent_placed_on_computer(
    agent_id: str,
    target_computer_id: str,
    *,
    node_ids: Set[str],
    placement_store: Any,
) -> bool:
    """Whether the agent holds an active placement on the target computer.

    Legacy placements predate stable computer ids and only name a daemon node,
    so they match when that node is one of the computer's ``node_ids``.
    """
    return any(
        placement.get("desiredState") == "active"
        and (
            placement["computerId"] == target_computer_id
            if placement.get("computerId")
            else placement.get("daemonNodeId") in node_ids
        )
        for placement in placement_store.list_placements(agent_id=agent_id)
    )


def assert_agent_can_move(
    agent: Mapping[str, Any],
    target_computer_id: str,
    *,
    team_store: Any,
    project_store: Any,
) -> None:
    """Refuse a move that would strand the agent's team or project.

    A team and a project each live on one computer with every member on it,
    so an agent must leave them before it can leave their computer. A team
    that never recorded a computer predates the rule and does not pin it.
    """
    if agent.get("computerId") == target_computer_id:
        return
    for team in team_store.list_teams(agent.get("supervisorEmployeeId")):
        if (
            agent["id"] in team.get("memberAgentIds", [])
            and team.get("computerId")
            and team["computerId"] != target_computer_id
        ):
            raise AgentMoveError(
                "agent_team_computer_mismatch",
                f"Agent belongs to team {team.get('name') or team['id']} on another "
                "computer. Remove it from the team before moving it.",
            )
    for project in project_store.list_projects(include_archived=False):
        if project.get("computerId") != target_computer_id and any(
            member.get("agentId") == agent["id"] for member in project.get("members", [])
        ):
            raise AgentMoveError(
                "agent_project_computer_mismatch",
                "Agent belongs to a project on another computer. Remove it from "
                "the project before moving it.",
            )


def place_agent_on_node(
    agent_store: Any,
    placement_store: Any,
    agent: dict[str, Any],
    node: Mapping[str, Any],
    payload: dict[str, Any] | None = None,
    *,
    team_store: Any,
    project_store: Any,
) -> dict[str, Any]:
    """Place an agent on a node, moving it when the node is another computer.

    The placement store supersedes the agent's prior placement; recording the
    move on the agent afterwards keeps its ``computerId`` truthful without
    moving an agent whose placement was rejected.
    """
    assert_agent_can_move(
        agent, computer_id(node), team_store=team_store, project_store=project_store
    )
    placement = create_node_placement(placement_store, agent, dict(node), payload)
    if agent.get("computerId") != placement["computerId"]:
        agent_store.move_to_computer(agent["id"], placement["computerId"])
    return placement


def _placement_computer_id(
    placement: Mapping[str, Any], nodes_by_id: Mapping[str, Mapping[str, Any]]
) -> str | None:
    if placement.get("computerId"):
        return placement["computerId"]
    node = nodes_by_id.get(placement.get("daemonNodeId") or "")
    return computer_id(node) if node else None
