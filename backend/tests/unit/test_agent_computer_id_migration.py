from __future__ import annotations

from pathlib import Path
from types import SimpleNamespace


from relay.migrations_runtime.agent_computer_id import (
    migrate_agent_computer_ids,
    migrate_agent_placement_computer_ids,
)
from relay.persistence.agent_placement_store import DatabaseAgentPlacementStore, create_node_placement
from relay.persistence.agent_store import DatabaseAgentStore


def _node(node_id: str = "node-1") -> dict:
    return {
        "id": node_id,
        "userId": "alice",
        "workspaceId": "machine-a",
        "workspacePath": "/w",
    }


def _stores(tmp_path: Path, db_name: str = "migration.db"):
    database_url = f"sqlite:///{tmp_path}/{db_name}"
    agents = DatabaseAgentStore(database_url, create_schema=True)
    placements = DatabaseAgentPlacementStore(database_url, create_schema=True)
    return agents, placements


def test_migrates_a_compatibility_agent_into_a_plain_agent(
    tmp_path: Path
) -> None:
    agents, placements = _stores(tmp_path)
    agent = agents.ensure_compatibility_agent(
        "alice", "claude", "node-1", computer_id="device:alice:machine-a"
    )
    create_node_placement(placements, agent, _node())

    assert migrate_agent_computer_ids(agents, placements) == 1

    migrated = agents.get_agent(agent["id"])
    assert migrated["id"] == agent["id"]          # id stays stable; history is unbroken
    assert migrated["computerId"] == "device:alice:machine-a"
    assert not migrated.get("compatibilityKey")
    assert migrated["defaultRole"] == "implementer"


def test_migration_is_idempotent(tmp_path: Path) -> None:
    agents, placements = _stores(tmp_path)
    agent = agents.ensure_compatibility_agent(
        "alice", "claude", "node-1", computer_id="device:alice:machine-a"
    )
    create_node_placement(placements, agent, _node())

    assert migrate_agent_computer_ids(agents, placements) == 1
    assert migrate_agent_computer_ids(agents, placements) == 0


def test_agent_without_a_placement_is_skipped_without_crashing(
    tmp_path: Path
) -> None:
    """Legacy reasons leave some records with no placement; skip instead of
    crashing, and they later surface as computer_gone."""
    agents, placements = _stores(tmp_path)
    agent = agents.ensure_compatibility_agent(
        "alice", "claude", "node-1", computer_id="device:alice:machine-a"
    )

    assert migrate_agent_computer_ids(agents, placements) == 0
    assert agents.get_agent(agent["id"])["compatibilityKey"]


def test_legacy_placement_without_computer_id_falls_back_to_the_registry(
    tmp_path: Path
) -> None:
    """spec ① only wrote computerId onto newly created placements; legacy
    ones must derive it from the registry instead."""
    agents, placements = _stores(tmp_path)
    agent = agents.ensure_compatibility_agent(
        "alice", "claude", "node-1", computer_id="device:alice:machine-a"
    )
    placements.create_placement(agent, "node-1")  # bypasses create_node_placement, so no computerId
    registry = SimpleNamespace(monitor_nodes=lambda: [_node()])

    assert migrate_agent_computer_ids(agents, placements, registry) == 1
    assert agents.get_agent(agent["id"])["computerId"] == "device:alice:machine-a"


def test_migrates_stable_identity_onto_active_legacy_placements(
    tmp_path: Path
) -> None:
    agents, placements = _stores(tmp_path)
    agent = agents.create_agent(
        "alice",
        {
            "displayName": "Ada",
            "executorKind": "claude",
            "defaultRole": "implementer",
            "computerId": "device:alice:machine-a",
        },
    )
    legacy = placements.create_placement(agent, "node-1")
    registry = SimpleNamespace(monitor_nodes=lambda: [_node()])

    assert migrate_agent_placement_computer_ids(placements, registry) == 1
    migrated = placements.get_placement(legacy["id"])
    assert migrated["computerId"] == "device:alice:machine-a"
    assert migrate_agent_placement_computer_ids(placements, registry) == 0


def test_migration_defers_while_only_a_provisional_node_identity_exists(
    tmp_path: Path
) -> None:
    agents, placements = _stores(tmp_path)
    agent = agents.ensure_compatibility_agent("alice", "claude", "node-1")
    legacy = placements.create_placement(agent, "node-1")
    registry = SimpleNamespace(
        monitor_nodes=lambda: [{"id": "node-1", "userId": "alice"}]
    )

    assert migrate_agent_placement_computer_ids(placements, registry) == 0
    assert migrate_agent_computer_ids(agents, placements, registry) == 0

    unchanged_agent = agents.get_agent(agent["id"])
    unchanged_placement = placements.get_placement(legacy["id"])
    assert unchanged_agent.get("computerId") is None
    assert unchanged_agent["compatibilityKey"]
    assert unchanged_placement.get("computerId") is None


def test_migration_promotes_an_existing_provisional_agent_identity(
    tmp_path: Path
) -> None:
    agents, placements = _stores(tmp_path)
    agent = agents.create_agent(
        "alice",
        {
            "displayName": "Ada",
            "executorKind": "claude",
            "defaultRole": "implementer",
            "computerId": "node:node-1",
        },
    )
    placements.create_placement(
        agent, "node-1", {"computerId": "device:alice:machine-a"}
    )

    assert migrate_agent_computer_ids(agents, placements) == 1
    assert agents.get_agent(agent["id"])["computerId"] == "device:alice:machine-a"


def test_placement_migration_replaces_an_existing_provisional_identity(
    tmp_path: Path
) -> None:
    agents, placements = _stores(tmp_path)
    agent = agents.create_agent(
        "alice",
        {
            "displayName": "Ada",
            "executorKind": "claude",
            "defaultRole": "implementer",
            "computerId": "node:node-1",
        },
    )
    provisional = placements.create_placement(
        agent, "node-1", {"computerId": "node:node-1"}
    )
    registry = SimpleNamespace(monitor_nodes=lambda: [_node()])

    assert migrate_agent_placement_computer_ids(placements, registry) == 1
    assert (
        placements.get_placement(provisional["id"])["computerId"]
        == "device:alice:machine-a"
    )


def test_one_agent_failing_to_migrate_does_not_block_the_rest(
    tmp_path: Path
) -> None:
    """A single per-agent failure mid-loop must not abort the whole run.
    Before the per-iteration try/except, any exception other than the
    "no placement" case aborted the entire loop, and because the failure was
    deterministic on the same record, every subsequent app restart failed at
    that exact agent and nothing after it in iteration order ever migrated.
    Here the first agent's set_birth_certificate call raises; the second,
    otherwise-valid agent must still migrate in the same run.
    """
    agents, placements = _stores(tmp_path)
    broken_agent = agents.ensure_compatibility_agent(
        "alice", "claude", "node-1", computer_id="device:alice:machine-a"
    )
    create_node_placement(placements, broken_agent, _node("node-1"))
    healthy_agent = agents.ensure_compatibility_agent(
        "bob", "claude", "node-2", computer_id="device:bob:machine-b"
    )
    node_2 = {
        "id": "node-2",
        "userId": "bob",
        "workspaceId": "machine-b",
        "workspacePath": "/w",
    }
    create_node_placement(placements, healthy_agent, node_2)

    real_set_birth_certificate = agents.set_birth_certificate

    def flaky_set_birth_certificate(agent_id: str, **kwargs):
        if agent_id == broken_agent["id"]:
            raise RuntimeError("simulated corrupt legacy record")
        return real_set_birth_certificate(agent_id, **kwargs)

    agents.set_birth_certificate = flaky_set_birth_certificate  # type: ignore[method-assign]

    assert migrate_agent_computer_ids(agents, placements) == 1

    still_broken = agents.get_agent(broken_agent["id"])
    assert still_broken["compatibilityKey"]  # untouched by the failed attempt

    migrated_healthy = agents.get_agent(healthy_agent["id"])
    assert not migrated_healthy.get("compatibilityKey")
    assert migrated_healthy["computerId"] == "device:bob:machine-b"


def test_plain_agents_are_left_alone(tmp_path: Path) -> None:
    agents, placements = _stores(tmp_path)
    agents.create_agent(
        "alice",
        {
            "displayName": "Ada",
            "executorKind": "claude",
            "defaultRole": "reviewer",
            "computerId": "device:alice:machine-a",
        },
    )
    assert migrate_agent_computer_ids(agents, placements) == 0


def test_migration_picks_the_active_placement_over_a_removed_one(
    tmp_path: Path
) -> None:
    """Critical regression: an agent that has switched computers carries one
    active placement and at least one removed (superseded) placement. Both
    stores sort placements by (priority, id) where id is a random uuid, so
    picking "the first placement with a computerId" without filtering out
    removed placements is a coin flip between the current and a retired
    computer. The migration must always land on the *active* placement's
    computer id, regardless of how the placements happen to sort.
    """
    old_node = _node("node-old")
    new_node = {**_node("node-new"), "workspaceId": "machine-b"}

    for attempt in range(5):
        agents, placements = _stores(
            tmp_path, db_name=f"active-pick-{attempt}.db"
        )
        agent = agents.ensure_compatibility_agent(
            "alice", "claude", "node-old", computer_id="device:alice:machine-a"
        )
        # First placement, then move the agent to a new computer: the store
        # marks the old placement "removed" and creates a new active one.
        create_node_placement(placements, agent, old_node)
        create_node_placement(placements, agent, new_node)

        active = placements.list_placements(agent_id=agent["id"])
        assert [p["daemonNodeId"] for p in active] == ["node-new"]

        assert migrate_agent_computer_ids(agents, placements) == 1

        migrated = agents.get_agent(agent["id"])
        assert migrated["computerId"] == "device:alice:machine-b", (
            f"attempt {attempt}: migrated to {migrated['computerId']!r} instead "
            "of the active computer's id"
        )


def test_active_legacy_placement_wins_over_removed_stable_history(
    tmp_path: Path
) -> None:
    agents, placements = _stores(tmp_path)
    old_node = _node("node-old")
    current_node = {**_node("node-current"), "workspaceId": "machine-b"}
    agent = agents.ensure_compatibility_agent(
        "alice", "claude", "node-old", computer_id="device:alice:machine-a"
    )
    create_node_placement(placements, agent, old_node)
    placements.create_placement(agent, "node-current")
    registry = SimpleNamespace(monitor_nodes=lambda: [old_node, current_node])

    assert migrate_agent_computer_ids(agents, placements, registry) == 1
    assert agents.get_agent(agent["id"])["computerId"] == "device:alice:machine-b"
