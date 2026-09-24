from __future__ import annotations

import json
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from threading import Barrier, Lock

import pytest
from sqlalchemy import update

from relay.persistence.agent_store import LocalAgentStore
from relay.persistence import team_store as team_store_module
from relay.persistence.team_store import DatabaseTeamStore, LocalTeamStore


def test_membership_contract_survives_updates_and_removal(team_store) -> None:
    team = team_store.create_team("alice", {
        "name": "Delivery", "leadAgentId": "lead", "memberAgentIds": ["lead", "builder"],
        "memberConfigs": {"builder": {"role": "implementer", "responsibility": "API and API tests", "required": True}},
        "acceptanceCriteria": ["Existing clients remain compatible"],
    })
    assert team["memberConfigs"]["builder"]["responsibility"] == "API and API tests"
    updated = team_store.update_team(team["id"], {"name": "API delivery"})
    assert updated["memberConfigs"] == team["memberConfigs"]
    assert updated["acceptanceCriteria"] == team["acceptanceCriteria"]
    removed = team_store.remove_member(team["id"], "builder")
    assert "builder" not in removed["memberConfigs"]


@pytest.mark.parametrize("config", [
    {"stranger": {"role": "reviewer"}},
    {"lead": {"role": "root"}},
    {"lead": {"required": "false"}},
    {"lead": {"responsibility": "x" * 4001}},
    {"lead": {"toolPolicy": {"allowAll": True}}},
])
def test_membership_contract_rejects_invalid_configuration(team_store, config) -> None:
    with pytest.raises(ValueError):
        team_store.create_team("alice", {
            "name": "Delivery", "leadAgentId": "lead", "memberAgentIds": ["lead"],
            "memberConfigs": config,
        })


@pytest.fixture(params=["local", "database"])
def team_store(request: pytest.FixtureRequest, tmp_path: Path):
    if request.param == "database":
        return DatabaseTeamStore(f"sqlite:///{tmp_path}/teams.db", create_schema=True)
    return LocalTeamStore(tmp_path)


def test_team_collaboration_style_is_stored_updated_and_cleared(team_store) -> None:
    team = team_store.create_team("alice", {
        "name": "Delivery", "leadAgentId": "lead", "memberAgentIds": ["lead"],
        "collaborationStyle": "pipeline",
    })
    assert team["collaborationStyle"] == "pipeline"
    updated = team_store.update_team(team["id"], {"collaborationStyle": "lead_led"})
    assert updated["collaborationStyle"] == "lead_led"
    renamed = team_store.update_team(team["id"], {"name": "Delivery 2"})
    assert renamed["collaborationStyle"] == "lead_led"
    cleared = team_store.update_team(team["id"], {"collaborationStyle": None})
    assert "collaborationStyle" not in cleared


def test_team_without_a_style_has_no_field(team_store) -> None:
    team = team_store.create_team("alice", {"name": "D", "leadAgentId": "lead", "memberAgentIds": ["lead"]})
    assert "collaborationStyle" not in team


@pytest.mark.parametrize("value", ["debate", "", 1])
def test_team_rejects_an_unknown_collaboration_style(team_store, value) -> None:
    with pytest.raises(ValueError, match="collaborationStyle must be one of"):
        team_store.create_team("alice", {
            "name": "D", "leadAgentId": "lead", "memberAgentIds": ["lead"], "collaborationStyle": value,
        })


def test_team_store_crud_and_events(team_store) -> None:
    created = team_store.create_team(
        "alice",
        {
            "name": "Delivery",
            "leadAgentId": "agent_lead",
            "memberAgentIds": ["agent_lead", "agent_support"],
        },
    )

    updated = team_store.update_team(
        created["id"], {"name": "Delivery crew", "enabled": False}
    )

    assert updated["ownerEmployeeId"] == "alice"
    assert "supervisorEmployeeId" not in updated
    assert updated["name"] == "Delivery crew"
    assert updated["enabled"] is False
    assert team_store.list_teams(owner_employee_id="alice") == [updated]
    assert [event["type"] for event in team_store.events(created["id"])] == [
        "team.created",
        "team.updated",
    ]

    deleted = team_store.delete_team(created["id"])
    assert deleted["deletedAt"]
    assert team_store.list_teams(owner_employee_id="alice") == []
    assert team_store.get_team(created["id"])["deletedAt"]


def test_team_store_normalizes_legacy_supervisor_owner(team_store) -> None:
    created = team_store.create_team(
        "alice",
        {
            "name": "Legacy delivery",
            "leadAgentId": "agent_lead",
            "memberAgentIds": ["agent_lead"],
        },
    )
    legacy = {
        **{key: value for key, value in created.items() if key != "ownerEmployeeId"},
        "supervisorEmployeeId": "alice",
    }
    if isinstance(team_store, DatabaseTeamStore):
        with team_store.engine.begin() as conn:
            conn.execute(
                update(team_store.teams)
                .where(team_store.teams.c.id == created["id"])
                .values(snapshot=legacy)
            )
    else:
        snapshot_path = team_store._snapshot_path(created["id"])
        snapshot_path.write_text(json.dumps(legacy), encoding="utf-8")

    loaded = team_store.get_team(created["id"])
    assert loaded["ownerEmployeeId"] == "alice"
    assert "supervisorEmployeeId" not in loaded
    assert team_store.list_teams(owner_employee_id="alice") == [loaded]

    updated = team_store.update_team(created["id"], {"name": "Legacy crew"})
    assert updated["ownerEmployeeId"] == "alice"
    assert "supervisorEmployeeId" not in updated


def test_team_names_are_unique_per_owner(team_store) -> None:
    payload = {
        "name": "Delivery",
        "leadAgentId": "agent_lead",
        "memberAgentIds": ["agent_lead"],
    }
    team_store.create_team("alice", payload)

    with pytest.raises(ValueError, match="team_name_taken"):
        team_store.create_team("alice", {**payload, "name": "delivery"})

    assert team_store.create_team("bob", payload)


def test_remove_member_promotes_the_first_remaining_member(team_store) -> None:
    team = team_store.create_team(
        "alice",
        {
            "name": "Delivery",
            "leadAgentId": "agent_lead",
            "memberAgentIds": ["agent_lead", "agent_support", "agent_review"],
        },
    )

    promoted = team_store.remove_member(team["id"], "agent_lead")
    emptied = team_store.remove_member(team["id"], "agent_support")
    emptied = team_store.remove_member(team["id"], "agent_review")

    assert promoted["leadAgentId"] == "agent_support"
    assert promoted["memberAgentIds"] == ["agent_support", "agent_review"]
    assert emptied["leadAgentId"] is None
    assert emptied["memberAgentIds"] == []


def test_database_team_updates_merge_from_the_locked_snapshot(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    database_url = f"sqlite:///{tmp_path}/teams.db"
    first = DatabaseTeamStore(database_url, create_schema=True)
    second = DatabaseTeamStore(database_url)
    team = first.create_team(
        "alice",
        {
            "name": "Delivery",
            "leadAgentId": "agent_lead",
            "memberAgentIds": ["agent_lead"],
        },
    )
    stale_read_barrier = Barrier(2)
    first_write_lock = Lock()
    first_write_count = 0
    original_team_row = team_store_module._team_row

    def synchronize_first_writes(*args, **kwargs):
        nonlocal first_write_count
        with first_write_lock:
            first_write_count += 1
            should_wait = first_write_count <= 2
        if should_wait:
            stale_read_barrier.wait()
        return original_team_row(*args, **kwargs)

    monkeypatch.setattr(team_store_module, "_team_row", synchronize_first_writes)

    with ThreadPoolExecutor(max_workers=2) as executor:
        rename = executor.submit(first.update_team, team["id"], {"name": "Delivery crew"})
        disable = executor.submit(second.update_team, team["id"], {"enabled": False})
        rename.result()
        disable.result()

    updated = first.get_team(team["id"])
    assert updated is not None
    assert updated["name"] == "Delivery crew"
    assert updated["enabled"] is False
    updates = [
        event["patch"]
        for event in first.events(team["id"])
        if event["type"] == "team.updated"
    ]
    assert {tuple(patch) for patch in updates} == {("name",), ("enabled",)}


def test_validate_team_payload_checks_membership(tmp_path: Path) -> None:
    agents = LocalAgentStore(tmp_path)
    lead = agents.create_agent(
        "alice", {"displayName": "Lead", "executorKind": "codex", "defaultRole": "implementer"}
    )
    support = agents.create_agent(
        "alice", {"displayName": "Support", "executorKind": "claude", "defaultRole": "implementer"}
    )
    outsider = agents.create_agent(
        "bob", {"displayName": "Outsider", "executorKind": "pi", "defaultRole": "implementer"}
    )

    from relay.persistence.team_store import validate_team_payload

    assert validate_team_payload(
        "alice",
        {"leadAgentId": lead["id"], "memberAgentIds": [lead["id"], support["id"]]},
        agents,
    ) == (lead["id"], [lead["id"], support["id"]])

    with pytest.raises(ValueError, match="team_lead_not_member"):
        validate_team_payload(
            "alice",
            {"leadAgentId": lead["id"], "memberAgentIds": [support["id"]]},
            agents,
        )
    with pytest.raises(ValueError, match="team_member_wrong_supervisor"):
        validate_team_payload(
            "alice",
            {"leadAgentId": outsider["id"], "memberAgentIds": [outsider["id"]]},
            agents,
        )
    with pytest.raises(ValueError, match="team_member_not_found"):
        validate_team_payload(
            "alice",
            {"leadAgentId": "missing", "memberAgentIds": ["missing"]},
            agents,
        )
    with pytest.raises(ValueError, match="team_members_duplicate"):
        validate_team_payload(
            "alice",
            {"leadAgentId": lead["id"], "memberAgentIds": [lead["id"], lead["id"]]},
            agents,
        )
