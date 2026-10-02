from __future__ import annotations

from pathlib import Path
from uuid import UUID

import pytest
from relay.persistence.agent_store import (
    DatabaseAgentStore,
    LocalAgentStore,
)


@pytest.mark.parametrize("store_kind", ["local", "database"])
def test_agent_stores_create_uuid_agent_ids(tmp_path: Path, store_kind: str) -> None:
    store = (
        LocalAgentStore(tmp_path / "local")
        if store_kind == "local"
        else DatabaseAgentStore(
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


def test_employee_can_own_multiple_agents_of_the_same_executor_kind(
    tmp_path: Path,
) -> None:
    store = LocalAgentStore(tmp_path)

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
        agent["displayName"] for agent in store.list_agents(supervisor_employee_id="alice")
    } == {"Researcher", "Reviewer"}


def test_agent_names_are_unique_within_an_employee(tmp_path: Path) -> None:
    store = LocalAgentStore(tmp_path)
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
    store = LocalAgentStore(tmp_path)
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


@pytest.mark.parametrize("store_kind", ["local", "database"])
def test_deleted_agent_releases_compatibility_identity(
    tmp_path: Path, store_kind: str
) -> None:
    store = (
        LocalAgentStore(tmp_path / "local")
        if store_kind == "local"
        else DatabaseAgentStore(
            f"sqlite:///{tmp_path}/agents.db", create_schema=True
        )
    )
    original = store.ensure_compatibility_agent(
        "alice", "claude", "runtime-1", computer_id="computer-1"
    )

    deleted = store.delete_agent(original["id"])
    replacement = store.ensure_compatibility_agent(
        "alice", "claude", "runtime-2", computer_id="computer-1"
    )

    # The identity is released because uniqueness is scoped to live agents, not
    # because the deleted agent forgets which Computer it belonged to.
    assert deleted["compatibilityKey"] == "alice:computer-1:claude"
    assert replacement["id"] != original["id"]
    assert replacement["compatibilityKey"] == "alice:computer-1:claude"


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
    legacy = {**agent, "employeeId": "alice"}
    legacy.pop("supervisorEmployeeId")
    with store.engine.begin() as conn:
        conn.execute(
            store.agents.update()
            .where(store.agents.c.id == agent["id"])
            .values(snapshot=legacy)
        )

    assert store.get_agent(agent["id"])["supervisorEmployeeId"] == "alice"


def test_create_agent_records_the_computer_id(tmp_path) -> None:
    from relay.persistence.agent_store import LocalAgentStore

    store = LocalAgentStore(tmp_path)
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
    from relay.persistence.agent_store import LocalAgentStore

    store = LocalAgentStore(tmp_path)
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
    from relay.persistence.agent_store import LocalAgentStore

    store = LocalAgentStore(tmp_path)
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
    """computerId / executorKind / defaultRole are the birth certificate;
    changing them is like swapping in a different coworker."""
    from relay.persistence.agent_store import LocalAgentStore

    store = LocalAgentStore(tmp_path)
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
        ("defaultRole", "reviewer"),
    ):
        with pytest.raises(ValueError):
            store.update_agent(agent["id"], {field: value})


def test_personality_fields_remain_patchable(tmp_path) -> None:
    from relay.persistence.agent_store import LocalAgentStore

    store = LocalAgentStore(tmp_path)
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


def test_database_enforces_employee_scoped_normalized_agent_names() -> None:
    unique_indexes = {
        index.name: tuple(sorted(column.name for column in index.columns))
        for index in DatabaseAgentStore.agents.indexes
        if index.unique
    }

    # Scoped to live agents, so a soft delete frees the name without having to
    # erase its own key columns.
    assert unique_indexes["uq_agents_live_supervisor_display_name"] == (
        "display_name_key",
        "supervisor_employee_id",
    )
    assert unique_indexes["uq_agents_live_compatibility_key"] == ("compatibility_key",)
