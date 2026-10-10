from __future__ import annotations

from typing import Any

from relay.services.agent_location import (
    agent_computer_ids,
    agent_placed_on_computer,
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
