from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import pytest
from relay.persistence.agent_placement_store import (
    DatabaseAgentPlacementStore,
    _new_placement,
    _placement_row,
    placement_status,
    reconcile_single_active_placement,
)
from store_fixtures import make_agent_placement_store
from relay.persistence.agent_store import DatabaseAgentStore
from store_fixtures import make_agent_store


def test_agents_can_be_placed_on_different_nodes(tmp_path: Path) -> None:
    agents = make_agent_store(tmp_path)
    placements = make_agent_placement_store(tmp_path)
    researcher = agents.create_agent(
        "alice",
        {
            "displayName": "Researcher",
            "executorKind": "claude",
            "defaultRole": "implementer",
        },
    )
    builder = agents.create_agent(
        "alice",
        {
            "displayName": "Builder",
            "executorKind": "codex",
            "defaultRole": "implementer",
        },
    )

    first = placements.create_placement(researcher, "node_a")
    second = placements.create_placement(builder, "node_b")

    assert first["daemonNodeId"] == "node_a"
    assert second["daemonNodeId"] == "node_b"


def test_moving_an_agent_to_a_new_computer_supersedes_the_old_placement(
    tmp_path: Path,
) -> None:
    agents = make_agent_store(tmp_path)
    placements = make_agent_placement_store(tmp_path)
    agent = agents.create_agent(
        "alice",
        {
            "displayName": "Researcher",
            "executorKind": "claude",
            "defaultRole": "implementer",
        },
    )

    first = placements.create_placement(agent, "node_a")
    second = placements.create_placement(agent, "node_b")

    # One agent lives on exactly one computer: the second assignment moves it.
    active = placements.list_placements(agent_id=agent["id"])
    assert [placement["daemonNodeId"] for placement in active] == ["node_b"]
    assert placements.get_placement(first["id"])["desiredState"] == "removed"
    assert second["daemonNodeId"] == "node_b"


def test_reassigning_the_same_computer_is_rejected(tmp_path: Path) -> None:
    agents = make_agent_store(tmp_path)
    placements = make_agent_placement_store(tmp_path)
    agent = agents.create_agent(
        "alice",
        {
            "displayName": "Researcher",
            "executorKind": "claude",
            "defaultRole": "implementer",
        },
    )
    placements.create_placement(agent, "node_a")

    try:
        placements.create_placement(agent, "node_a")
    except ValueError as error:
        assert "already" in str(error)
    else:  # pragma: no cover - guard
        raise AssertionError("expected a rejection for a duplicate placement")


def test_database_store_moves_an_agent_between_computers(tmp_path: Path) -> None:
    database_url = f"sqlite:///{tmp_path}/move.db"
    agents = DatabaseAgentStore(database_url, create_schema=True)
    placements = DatabaseAgentPlacementStore(database_url, create_schema=True)
    agent = agents.create_agent(
        "alice",
        {
            "displayName": "Researcher",
            "executorKind": "claude",
            "defaultRole": "implementer",
        },
    )

    placements.create_placement(agent, "node_a")
    placements.create_placement(agent, "node_b")

    active = placements.list_placements(agent_id=agent["id"])
    assert [placement["daemonNodeId"] for placement in active] == ["node_b"]


def test_first_managed_attachment_is_idempotent_across_store_instances(
    tmp_path: Path
) -> None:
    database_url = f"sqlite:///{tmp_path}/first-attach.db"
    agents = DatabaseAgentStore(database_url, create_schema=True)
    first_store = DatabaseAgentPlacementStore(database_url, create_schema=True)
    second_store = DatabaseAgentPlacementStore(database_url)
    agent = agents.create_agent(
        "alice",
        {
            "displayName": "Worker",
            "executorKind": "claude",
            "defaultRole": "implementer",
        },
    )
    phantom = first_store.create_placement(agent, "node-missing")
    target = {
        "id": "node-ready",
        "userId": "alice",
        "managedNodeId": "computer-ready",
    }

    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(
            pool.map(
                lambda store: store.attach_first_managed_placement(
                    agent,
                    target,
                    expected_placement_ids={phantom["id"]},
                ),
                (first_store, second_store),
            )
        )

    assert results[0] is not None and results[1] is not None
    assert results[0]["id"] == results[1]["id"]
    [active] = first_store.list_placements(agent_id=agent["id"])
    assert active["computerId"] == "managed:computer-ready"


def test_first_managed_attachment_allows_only_one_competing_computer(
    tmp_path: Path
) -> None:
    database_url = f"sqlite:///{tmp_path}/competing-attach.db"
    agents = DatabaseAgentStore(database_url, create_schema=True)
    first_store = DatabaseAgentPlacementStore(database_url, create_schema=True)
    second_store = DatabaseAgentPlacementStore(database_url)
    agent = agents.create_agent(
        "alice",
        {
            "displayName": "Worker",
            "executorKind": "claude",
            "defaultRole": "implementer",
        },
    )
    phantom = first_store.create_placement(agent, "node-missing")
    targets = (
        {"id": "node-a", "userId": "alice", "managedNodeId": "computer-a"},
        {"id": "node-b", "userId": "alice", "managedNodeId": "computer-b"},
    )

    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(
            pool.map(
                lambda pair: pair[0].attach_first_managed_placement(
                    agent,
                    pair[1],
                    expected_placement_ids={phantom["id"]},
                ),
                ((first_store, targets[0]), (second_store, targets[1])),
            )
        )

    assert sum(result is not None for result in results) == 1
    [active] = first_store.list_placements(agent_id=agent["id"])
    assert active["computerId"] in {"managed:computer-a", "managed:computer-b"}


def test_runtime_rebind_preserves_placement_identity(
    tmp_path: Path
) -> None:
    database_url = f"sqlite:///{tmp_path}/rebind.db"
    agents = DatabaseAgentStore(database_url, create_schema=True)
    placements = DatabaseAgentPlacementStore(database_url, create_schema=True)
    agent = agents.create_agent(
        "alice",
        {
            "displayName": "Builder",
            "executorKind": "codex",
            "defaultRole": "implementer",
        },
    )
    original = placements.create_placement(agent, "runtime_old")

    rebound = placements.rebind_placement(
        original["id"], "runtime_new", managed_node_id="computer_one"
    )

    assert rebound["id"] == original["id"]
    assert rebound["daemonNodeId"] == "runtime_new"
    assert rebound["managedNodeId"] == "computer_one"
    assert rebound["computerId"] == "managed:computer_one"
    assert rebound["desiredState"] == "active"
    assert placements.list_placements(agent_id=agent["id"]) == [rebound]


def test_runtime_rebind_can_adopt_a_stable_local_computer_identity(
    tmp_path: Path
) -> None:
    database_url = f"sqlite:///{tmp_path}/local-rebind.db"
    agents = DatabaseAgentStore(database_url, create_schema=True)
    placements = DatabaseAgentPlacementStore(database_url, create_schema=True)
    agent = agents.create_agent(
        "alice",
        {
            "displayName": "Builder",
            "executorKind": "codex",
            "defaultRole": "implementer",
            "computerId": "device:alice:machine-a",
        },
    )
    original = placements.create_placement(agent, "runtime_old")

    rebound = placements.rebind_placement(
        original["id"],
        "runtime_new",
        computer_id_value="device:alice:machine-a",
    )

    assert rebound["id"] == original["id"]
    assert rebound["daemonNodeId"] == "runtime_new"
    assert rebound["computerId"] == "device:alice:machine-a"
    assert "managedNodeId" not in rebound


def test_database_move_keeps_old_placement_when_insert_fails(tmp_path: Path) -> None:
    database_url = f"sqlite:///{tmp_path}/atomic-move.db"
    agents = DatabaseAgentStore(database_url, create_schema=True)
    placements = DatabaseAgentPlacementStore(database_url, create_schema=True)
    agent = agents.create_agent(
        "alice",
        {
            "displayName": "Researcher",
            "executorKind": "claude",
            "defaultRole": "implementer",
        },
    )
    placements.create_placement(agent, "node_a")
    with placements.engine.begin() as conn:
        conn.exec_driver_sql(
            """
            CREATE TRIGGER reject_node_b
            BEFORE INSERT ON agent_placements
            WHEN NEW.daemon_node_id = 'node_b'
            BEGIN
                SELECT RAISE(ABORT, 'node_b rejected');
            END
            """
        )

    with pytest.raises(Exception, match="node_b rejected"):
        placements.create_placement(agent, "node_b")

    active = placements.list_placements(agent_id=agent["id"])
    assert [placement["daemonNodeId"] for placement in active] == ["node_a"]


def test_database_reconcile_collapses_pre_invariant_multi_placements(
    tmp_path: Path,
) -> None:
    database_url = f"sqlite:///{tmp_path}/reconcile.db"
    agents = DatabaseAgentStore(database_url, create_schema=True)
    placements = DatabaseAgentPlacementStore(database_url, create_schema=True)
    agent = agents.create_agent(
        "alice",
        {
            "displayName": "Researcher",
            "executorKind": "claude",
            "defaultRole": "implementer",
        },
    )
    placements.create_placement(agent, "node_low", {"priority": 200})
    extra = _new_placement(agent, "node_top", {"priority": 50})
    with placements.engine.begin() as conn:
        conn.execute(
            placements.placements.insert().values(
                **_placement_row(extra, event_version=1)
            )
        )
    assert len(placements.list_placements(agent_id=agent["id"])) == 2

    reconcile_single_active_placement(placements)

    active = placements.list_placements(agent_id=agent["id"])
    assert [placement["daemonNodeId"] for placement in active] == ["node_top"]
    assert reconcile_single_active_placement(placements) == []


def test_placement_availability_is_derived_from_agent_and_node_health(
    tmp_path: Path,
) -> None:
    agents = make_agent_store(tmp_path)
    placements = make_agent_placement_store(tmp_path)
    agent = agents.create_agent(
        "alice",
        {
            "displayName": "Builder",
            "executorKind": "codex",
            "defaultRole": "implementer",
        },
    )
    placement = placements.create_placement(agent, "node_a")
    node = {
        "id": "node_a",
        "online": True,
        "stale": False,
        "status": "ready",
        "agents": {"codex": "ready"},
    }

    assert placement_status(placement, agent, node)["status"] == "ready"
    assert (
        placement_status(placement, agent, {**node, "online": False})["status"]
        == "offline"
    )

    updated_agent = agents.update_agent(agent["id"], {"instructions": "Use tests."})
    result = placement_status(placement, updated_agent, node)
    assert result["status"] == "ready"
    assert result["conditions"] == []


def test_realized_agent_versions_never_move_backward(
    tmp_path: Path
) -> None:
    database_url = f"sqlite:///{tmp_path}/version.db"
    agents = DatabaseAgentStore(database_url, create_schema=True)
    placements = DatabaseAgentPlacementStore(database_url, create_schema=True)
    agent = agents.create_agent(
        "alice",
        {
            "displayName": "Builder",
            "executorKind": "codex",
            "defaultRole": "implementer",
        },
    )
    placement = placements.create_placement(agent, "node_a")

    placements.realize_agent_version(placement["id"], 3)
    placements.realize_agent_version(placement["id"], 2)

    assert placements.get_placement(placement["id"])["agentVersion"] == 3


def test_database_agent_placement_store_matches_local_contract(tmp_path: Path) -> None:
    database_url = f"sqlite:///{tmp_path}/placements.db"
    agents = DatabaseAgentStore(database_url, create_schema=True)
    placements = DatabaseAgentPlacementStore(database_url, create_schema=True)
    agent = agents.create_agent(
        "alice",
        {
            "displayName": "Builder",
            "executorKind": "codex",
            "defaultRole": "implementer",
        },
    )

    placement = placements.create_placement(agent, "node_a", {"priority": 20})
    updated = placements.update_placement(placement["id"], {"desiredState": "draining"})

    assert updated["desiredState"] == "draining"
    assert (
        DatabaseAgentPlacementStore(database_url).get_placement(placement["id"])[
            "priority"
        ]
        == 20
    )
    assert [event["type"] for event in placements.events(placement["id"])] == [
        "placement.created",
        "placement.draining",
    ]


def test_database_placement_store_normalizes_legacy_owner_snapshot(
    tmp_path: Path,
) -> None:
    database_url = f"sqlite:///{tmp_path}/legacy-placements.db"
    agents = DatabaseAgentStore(database_url, create_schema=True)
    placements = DatabaseAgentPlacementStore(database_url, create_schema=True)
    agent = agents.create_agent(
        "alice",
        {
            "displayName": "Builder",
            "executorKind": "codex",
            "defaultRole": "implementer",
        },
    )
    placement = placements.create_placement(agent, "node_a")
    legacy = {**placement, "userId": "alice"}
    legacy.pop("supervisorUserId")
    with placements.engine.begin() as conn:
        conn.execute(
            placements.placements.update()
            .where(placements.placements.c.id == placement["id"])
            .values(snapshot=legacy)
        )

    assert placements.get_placement(placement["id"])["supervisorUserId"] == "alice"


def test_rebinding_to_an_unmanaged_node_clears_the_computer_identity(
    tmp_path: Path
) -> None:
    database_url = f"sqlite:///{tmp_path}/clear-managed.db"
    agents = DatabaseAgentStore(database_url, create_schema=True)
    placements = DatabaseAgentPlacementStore(database_url, create_schema=True)
    agent = agents.create_agent(
        "alice",
        {
            "displayName": "Builder",
            "executorKind": "codex",
            "defaultRole": "implementer",
        },
    )
    original = placements.create_placement(agent, "runtime_old")
    managed = placements.rebind_placement(
        original["id"], "runtime_managed", managed_node_id="computer_one"
    )
    assert managed["managedNodeId"] == "computer_one"

    # A placement bound to a user device belongs to no managed Computer.
    # Leaving computer_one behind would let that Computer's sync reclaim it.
    device = placements.rebind_placement(original["id"], "device_node")

    assert device["daemonNodeId"] == "device_node"
    assert "managedNodeId" not in device
    assert "computerId" not in device
    assert placements.get_placement(original["id"]).get("managedNodeId") is None


def test_rebind_repairs_a_stale_computer_identity_on_the_same_node(
    tmp_path: Path
) -> None:
    database_url = f"sqlite:///{tmp_path}/repair-managed.db"
    agents = DatabaseAgentStore(database_url, create_schema=True)
    placements = DatabaseAgentPlacementStore(database_url, create_schema=True)
    agent = agents.create_agent(
        "alice",
        {
            "displayName": "Builder",
            "executorKind": "codex",
            "defaultRole": "implementer",
        },
    )
    original = placements.create_placement(agent, "device_node")
    placements.rebind_placement(
        original["id"], "device_node", managed_node_id="computer_one"
    )

    repaired = placements.rebind_placement(original["id"], "device_node")

    assert repaired.get("managedNodeId") is None
    assert repaired.get("computerId") is None


def test_placement_denormalized_agent_fields_cannot_drift(
    tmp_path: Path
) -> None:
    """Placements copy supervisorUserId and executorKind from the agent and
    never refresh them. That is only safe while neither is patchable, so pin it
    here: making either mutable must fail this test, not silently leave every
    placement pointing at the wrong user or executor."""
    store = (
        DatabaseAgentStore(f"sqlite:///{tmp_path}/agents.db", create_schema=True)
    )
    agent = store.create_agent(
        "alice",
        {
            "displayName": "Planner",
            "executorKind": "claude",
            "defaultRole": "implementer",
        },
    )

    for field, value in (
        ("supervisorUserId", "bob"),
        ("executorKind", "codex"),
    ):
        with pytest.raises(ValueError, match="Unsupported agent field"):
            store.update_agent(agent["id"], {field: value})


def test_placement_records_the_computer_identity(tmp_path) -> None:
    from relay.persistence.agent_placement_store import create_node_placement
    from store_fixtures import make_agent_placement_store
    from store_fixtures import make_agent_store

    agents = make_agent_store(tmp_path)
    placements = make_agent_placement_store(tmp_path)
    agent = agents.create_agent(
        "alice",
        {
            "displayName": "Worker",
            "executorKind": "claude",
            "defaultRole": "implementer",
        },
    )
    node = {
        "id": "node-1",
        "userId": "alice",
        "workspaceId": "machine-a",
        "workspacePath": "/w",
    }
    placement = create_node_placement(placements, agent, node)
    assert placement["computerId"] == "device:alice:machine-a"
