from __future__ import annotations

from pathlib import Path
from uuid import UUID

import pytest
from relay.persistence.agent.store import DatabaseAgentStore
from store_fixtures import make_agent_store


def test_agent_stores_create_uuid_agent_ids(tmp_path: Path) -> None:
    store = (
        DatabaseAgentStore(
            f"sqlite:///{tmp_path}/agents.db", create_schema=True
        )
    )

    agent = store.create_agent(
        "alice",
        {
            "displayName": "Researcher",
            "executorKind": "claude",
            "defaultRole": "implementer",
        },
    )

    assert str(UUID(agent["id"])) == agent["id"]


def test_user_can_own_multiple_agents_of_the_same_executor_kind(
    tmp_path: Path,
) -> None:
    store = make_agent_store(tmp_path)

    researcher = store.create_agent(
        "alice",
        {
            "displayName": "Researcher",
            "executorKind": "claude",
            "defaultRole": "implementer",
        },
    )
    reviewer = store.create_agent(
        "alice",
        {
            "displayName": "Reviewer",
            "executorKind": "claude",
            "defaultRole": "reviewer",
        },
    )

    assert researcher["executorKind"] == reviewer["executorKind"] == "claude"
    assert researcher["defaultRole"] == "implementer"
    assert reviewer["defaultRole"] == "reviewer"
    assert {
        agent["displayName"] for agent in store.list_agents(supervisor_user_id="alice")
    } == {"Researcher", "Reviewer"}


def test_agent_names_are_unique_within_an_user(tmp_path: Path) -> None:
    store = make_agent_store(tmp_path)
    store.create_agent(
        "alice",
        {
            "displayName": "Researcher",
            "executorKind": "claude",
            "defaultRole": "implementer",
        },
    )

    with pytest.raises(ValueError, match="already has an agent named"):
        store.create_agent(
            "alice",
            {
                "displayName": "researcher",
                "executorKind": "codex",
                "defaultRole": "implementer",
            },
        )

    assert store.create_agent(
        "bob",
        {
            "displayName": "Researcher",
            "executorKind": "codex",
            "defaultRole": "implementer",
        },
    )


def test_agent_updates_are_event_sourced_and_configuration_increments_version(
    tmp_path: Path,
) -> None:
    store = make_agent_store(tmp_path)
    agent = store.create_agent(
        "alice",
        {
            "displayName": "Builder",
            "executorKind": "codex",
            "defaultRole": "implementer",
        },
    )

    renamed = store.update_agent(agent["id"], {"displayName": "Implementer"})
    configured = store.update_agent(agent["id"], {"instructions": "Work test-first."})

    assert renamed["version"] == 1
    assert configured["version"] == 2
    assert [event["type"] for event in store.events(agent["id"])] == [
        "agent.created",
        "agent.updated",
        "agent.updated",
    ]


def test_database_agent_store_matches_local_contract(tmp_path: Path) -> None:
    database_url = f"sqlite:///{tmp_path}/agents.db"
    store = DatabaseAgentStore(database_url, create_schema=True)

    agent = store.create_agent(
        "alice",
        {
            "displayName": "Researcher",
            "executorKind": "claude",
            "defaultRole": "implementer",
            "instructions": "Cite sources.",
        },
    )
    updated = store.update_agent(agent["id"], {"instructions": "Cite primary sources."})

    assert updated["version"] == 2
    assert (
        DatabaseAgentStore(database_url).get_agent(agent["id"])["instructions"]
        == "Cite primary sources."
    )
    assert [event["type"] for event in store.events(agent["id"])] == [
        "agent.created",
        "agent.updated",
    ]


def test_deleted_agent_releases_compatibility_identity(
    tmp_path: Path
) -> None:
    store = (
        DatabaseAgentStore(
            f"sqlite:///{tmp_path}/agents.db", create_schema=True
        )
    )
    # Only a provisional Computer identity still mints a keyed agent.
    original = store.ensure_compatibility_agent(
        "alice", "claude", "runtime-1", computer_id="node:computer-1"
    )

    deleted = store.delete_agent(original["id"])
    replacement = store.ensure_compatibility_agent(
        "alice", "claude", "runtime-2", computer_id="node:computer-1"
    )

    # The identity is released because uniqueness is scoped to live agents, not
    # because the deleted agent forgets which Computer it belonged to.
    assert deleted["compatibilityKey"] == "alice:node:computer-1:claude"
    assert replacement["id"] != original["id"]
    assert replacement["compatibilityKey"] == "alice:node:computer-1:claude"


def test_database_agent_store_normalizes_legacy_owner_snapshot(tmp_path: Path) -> None:
    database_url = f"sqlite:///{tmp_path}/legacy-agents.db"
    store = DatabaseAgentStore(database_url, create_schema=True)
    agent = store.create_agent(
        "alice",
        {
            "displayName": "Builder",
            "executorKind": "codex",
            "defaultRole": "implementer",
        },
    )
    legacy = {**agent, "userId": "alice"}
    legacy.pop("supervisorUserId")
    with store.engine.begin() as conn:
        conn.execute(
            store.agents.update()
            .where(store.agents.c.id == agent["id"])
            .values(snapshot=legacy)
        )

    assert store.get_agent(agent["id"])["supervisorUserId"] == "alice"


def test_create_agent_records_the_computer_id(tmp_path) -> None:
    from store_fixtures import make_agent_store

    store = make_agent_store(tmp_path)
    agent = store.create_agent(
        "alice",
        {
            "displayName": "Ada",
            "executorKind": "claude",
            "defaultRole": "implementer",
            "computerId": "device:alice:machine-a",
        },
    )
    assert agent["computerId"] == "device:alice:machine-a"
    assert store.get_agent(agent["id"])["computerId"] == "device:alice:machine-a"


def test_create_agent_requires_a_default_role(tmp_path) -> None:
    from store_fixtures import make_agent_store

    store = make_agent_store(tmp_path)
    with pytest.raises(ValueError, match="defaultRole"):
        store.create_agent(
            "alice",
            {
                "displayName": "Ada",
                "executorKind": "claude",
                "computerId": "device:alice:machine-a",
            },
        )


def test_default_role_must_be_a_known_role(tmp_path) -> None:
    from store_fixtures import make_agent_store

    store = make_agent_store(tmp_path)
    with pytest.raises(ValueError, match="defaultRole"):
        store.create_agent(
            "alice",
            {
                "displayName": "Ada",
                "executorKind": "claude",
                "defaultRole": "chief-of-staff",
                "computerId": "device:alice:machine-a",
            },
        )


def test_birth_certificate_fields_cannot_be_patched(tmp_path) -> None:
    """computerId / executorKind are the birth certificate; changing them is
    like swapping in a different coworker. The role is not: it stays editable,
    but only to a known role."""
    from store_fixtures import make_agent_store

    store = make_agent_store(tmp_path)
    agent = store.create_agent(
        "alice",
        {
            "displayName": "Ada",
            "executorKind": "claude",
            "defaultRole": "implementer",
            "computerId": "device:alice:machine-a",
        },
    )
    for field, value in (
        ("computerId", "device:alice:machine-b"),
        ("executorKind", "codex"),
        ("defaultRole", "wizard"),
        ("defaultRole", None),
    ):
        with pytest.raises(ValueError):
            store.update_agent(agent["id"], {field: value})
    assert store.update_agent(agent["id"], {"defaultRole": "reviewer"})["defaultRole"] == "reviewer"


def test_personality_fields_remain_patchable(tmp_path) -> None:
    from store_fixtures import make_agent_store

    store = make_agent_store(tmp_path)
    agent = store.create_agent(
        "alice",
        {
            "displayName": "Ada",
            "executorKind": "claude",
            "defaultRole": "implementer",
            "computerId": "device:alice:machine-a",
        },
    )
    updated = store.update_agent(agent["id"], {"displayName": "Grace"})
    assert updated["displayName"] == "Grace"


def test_database_enforces_user_scoped_normalized_agent_names() -> None:
    unique_indexes = {
        index.name: tuple(sorted(column.name for column in index.columns))
        for index in DatabaseAgentStore.agents.indexes
        if index.unique
    }

    # Scoped to live agents, so a soft delete frees the name without having to
    # erase its own key columns.
    assert unique_indexes["uq_agents_live_supervisor_display_name"] == (
        "display_name_key",
        "supervisor_user_id",
    )
    assert unique_indexes["uq_agents_live_compatibility_key"] == ("compatibility_key",)


def _agent_store(tmp_path: Path):
    return make_agent_store(tmp_path)


def test_legacy_run_on_a_stable_computer_declares_a_plain_agent(tmp_path: Path) -> None:
    store = _agent_store(tmp_path)

    agent = store.ensure_compatibility_agent(
        "alice", "claude", "runtime-1", computer_id="device:alice:machine-a"
    )

    # Born declared: nothing is left for the startup migration to convert.
    assert agent.get("compatibilityKey") is None
    assert agent["computerId"] == "device:alice:machine-a"
    assert agent["defaultRole"] == "implementer"
    assert store.get_agent(agent["id"]).get("compatibilityKey") is None


def test_legacy_run_reuses_the_declared_agent_on_its_computer(tmp_path: Path) -> None:
    store = _agent_store(tmp_path)
    first = store.ensure_compatibility_agent(
        "alice", "claude", "runtime-1", computer_id="device:alice:machine-a"
    )

    # A reprovisioned runtime on the same Computer is the same agent, not a
    # duplicate — this is what used to happen once migration cleared the key.
    again = store.ensure_compatibility_agent(
        "alice", "claude", "runtime-2", computer_id="device:alice:machine-a"
    )

    assert again["id"] == first["id"]
    assert [item["id"] for item in store.list_agents(supervisor_user_id="alice")] == [
        first["id"]
    ]


def test_legacy_run_reuses_a_migrated_compatibility_agent(tmp_path: Path) -> None:
    store = _agent_store(tmp_path)
    keyed = store.ensure_compatibility_agent(
        "alice", "codex", "runtime-1", computer_id="node:runtime-1"
    )
    migrated = store.set_birth_certificate(
        keyed["id"], computer_id="device:alice:machine-a", default_role="implementer"
    )

    again = store.ensure_compatibility_agent(
        "alice", "codex", "runtime-1", computer_id="device:alice:machine-a"
    )

    assert migrated.get("compatibilityKey") is None
    assert again["id"] == keyed["id"]


def test_legacy_run_reuses_an_enabled_agent_when_an_older_one_is_disabled(tmp_path: Path) -> None:
    store = _agent_store(tmp_path)
    disabled = store.ensure_compatibility_agent(
        "alice", "claude", "runtime-1", computer_id="device:alice:machine-a"
    )
    store.update_agent(disabled["id"], {"enabled": False})
    enabled = store.create_agent(
        "alice",
        {
            "displayName": "Active agent",
            "executorKind": "claude",
            "defaultRole": "implementer",
            "computerId": "device:alice:machine-a",
        },
    )

    again = store.ensure_compatibility_agent(
        "alice", "claude", "runtime-2", computer_id="device:alice:machine-a"
    )

    assert again["id"] == enabled["id"]


def test_legacy_run_ignores_declared_agents_on_other_computers_or_runtimes(tmp_path: Path) -> None:
    store = _agent_store(tmp_path)
    elsewhere = store.create_agent(
        "alice",
        {
            "displayName": "Elsewhere",
            "executorKind": "claude",
            "defaultRole": "implementer",
            "computerId": "device:alice:machine-b",
        },
    )
    other_runtime = store.create_agent(
        "alice",
        {
            "displayName": "Reviewer",
            "executorKind": "codex",
            "defaultRole": "implementer",
            "computerId": "device:alice:machine-a",
        },
    )

    agent = store.ensure_compatibility_agent(
        "alice", "claude", "runtime-1", computer_id="device:alice:machine-a"
    )

    assert agent["id"] not in {elsewhere["id"], other_runtime["id"]}
    assert agent["executorKind"] == "claude"
    assert agent["computerId"] == "device:alice:machine-a"
