from __future__ import annotations

from typing import Any

import pytest

from relay.services.agent_location import (
    AgentMoveError,
    agent_computer_ids,
    agent_placed_on_computer,
    assert_agent_can_move,
)


class _Placements:
    def __init__(self, placements: list[dict[str, Any]]):
        self._placements = placements

    def list_placements(self, *, agent_id: str) -> list[dict[str, Any]]:
        return [item for item in self._placements if item["agentId"] == agent_id]


def _placement(
    agent_id: str,
    *,
    computer: str | None = None,
    node: str = "node-1",
    state: str = "active",
) -> dict[str, Any]:
    return {
        "agentId": agent_id,
        "daemonNodeId": node,
        "desiredState": state,
        **({"computerId": computer} if computer else {}),
    }


NODES = {"node-1": {"id": "node-1", "managedNodeId": "mn-1"}}


def test_a_durable_birth_certificate_is_the_agents_computer() -> None:
    agent = {"id": "a1", "computerId": "device:alice:machine-a"}
    # A stray legacy placement elsewhere must not add a second computer.
    store = _Placements([_placement("a1", computer="device:alice:machine-b")])

    assert agent_computer_ids(agent, placement_store=store, nodes_by_id=NODES) == {
        "device:alice:machine-a"
    }


def test_an_unplaced_agent_still_lives_on_its_birth_computer() -> None:
    agent = {"id": "a1", "computerId": "device:alice:machine-a"}

    assert agent_computer_ids(
        agent, placement_store=_Placements([]), nodes_by_id=NODES
    ) == {"device:alice:machine-a"}


def test_a_legacy_agent_is_located_by_its_live_placements() -> None:
    agent = {"id": "a1", "computerId": "node:node-1"}
    store = _Placements(
        [
            _placement("a1", computer="device:alice:machine-a", state="draining"),
            _placement("a1", computer="device:alice:machine-gone", state="removed"),
        ]
    )

    assert agent_computer_ids(agent, placement_store=store, nodes_by_id=NODES) == {
        "device:alice:machine-a"
    }


def test_a_legacy_placement_without_a_computer_resolves_through_its_node() -> None:
    agent = {"id": "a1"}
    store = _Placements([_placement("a1", node="node-1")])

    assert agent_computer_ids(agent, placement_store=store, nodes_by_id=NODES) == {
        "managed:mn-1"
    }


def test_placed_on_computer_requires_an_active_placement() -> None:
    store = _Placements(
        [_placement("a1", computer="device:alice:machine-a", state="draining")]
    )

    assert not agent_placed_on_computer(
        "a1", "device:alice:machine-a", node_ids={"node-1"}, placement_store=store
    )


def test_placed_on_computer_matches_legacy_placements_by_node() -> None:
    store = _Placements([_placement("a1", node="node-2")])

    assert agent_placed_on_computer(
        "a1", "device:alice:machine-a", node_ids={"node-1", "node-2"}, placement_store=store
    )
    assert not agent_placed_on_computer(
        "a1", "device:alice:machine-a", node_ids={"node-1"}, placement_store=store
    )


class _Teams:
    def __init__(self, teams: list[dict[str, Any]]):
        self._teams = teams

    def list_teams(self, owner_employee_id: str | None = None) -> list[dict[str, Any]]:
        return self._teams


class _Projects:
    def __init__(self, projects: list[dict[str, Any]]):
        self._projects = projects

    def list_projects(self, *, include_archived: bool = False) -> list[dict[str, Any]]:
        return self._projects


def test_an_agent_cannot_move_off_its_teams_computer() -> None:
    agent = {"id": "a1", "supervisorEmployeeId": "alice", "computerId": "device:alice:m1"}
    teams = _Teams(
        [{"id": "t1", "name": "Delivery", "computerId": "device:alice:m1", "memberAgentIds": ["a1"]}]
    )

    with pytest.raises(AgentMoveError) as error:
        assert_agent_can_move(
            agent, "device:alice:m2", team_store=teams, project_store=_Projects([])
        )

    assert error.value.code == "agent_team_computer_mismatch"


def test_an_agent_cannot_move_off_its_projects_computer() -> None:
    agent = {"id": "a1", "supervisorEmployeeId": "alice", "computerId": "device:alice:m1"}
    projects = _Projects(
        [{"id": "p1", "computerId": "device:alice:m1", "members": [{"agentId": "a1"}]}]
    )

    with pytest.raises(AgentMoveError) as error:
        assert_agent_can_move(
            agent, "device:alice:m2", team_store=_Teams([]), project_store=projects
        )

    assert error.value.code == "agent_project_computer_mismatch"


def test_staying_on_the_same_computer_or_a_free_agent_may_move() -> None:
    agent = {"id": "a1", "supervisorEmployeeId": "alice", "computerId": "device:alice:m1"}
    teams = _Teams(
        [{"id": "t1", "name": "Delivery", "computerId": "device:alice:m1", "memberAgentIds": ["a1"]}]
    )

    assert_agent_can_move(
        agent, "device:alice:m1", team_store=teams, project_store=_Projects([])
    )
    assert_agent_can_move(
        {**agent, "id": "a2"}, "device:alice:m2", team_store=teams, project_store=_Projects([])
    )
