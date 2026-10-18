"""The retired file stores import into the database once, completely, and safely."""

from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any

import pytest
from cryptography.fernet import Fernet

from relay.app import create_app
from relay.persistence.file_store_import import (
    local_file_stores_present,
    migrate_local_file_stores,
)
from store_fixtures import (
    make_agent_placement_store,
    make_agent_store,
    make_chat_store,
    make_daemon_store,
    make_team_store,
    sqlite_url,
)

NODE_ID = "11111111-1111-4111-8111-111111111111"
RETIRED_NODE_ID = "22222222-2222-4222-8222-222222222222"
AGENT_ID = "33333333-3333-4333-8333-333333333333"
TEAM_ID = "44444444-4444-4444-8444-444444444444"
PLACEMENT_ID = "55555555-5555-4555-8555-555555555555"
COMMAND_ID = "66666666-6666-4666-8666-666666666666"
WORKSPACE_COMMAND_ID = "77777777-7777-4777-8777-777777777777"
RUN_ID = "88888888-8888-4888-8888-888888888888"
RUN_REQUEST_ID = "99999999-9999-4999-8999-999999999999"
SESSION_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
INTEGRATION_ID = "chat_legacy_1"
T0 = "2026-06-13T00:00:00.000Z"
T1 = "2026-06-13T00:05:00.000Z"


def _write(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value), encoding="utf-8")


def _write_lines(path: Path, values: list[dict[str, Any]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("".join(json.dumps(value) + "\n" for value in values), encoding="utf-8")


def write_legacy_tree(root: Path, *, agent_name: str = "Builder") -> None:
    """One record of every kind, in the layout the file stores wrote."""
    daemon = root / "daemon"
    _write(daemon / "nodes" / f"{NODE_ID}.json", {
        "id": NODE_ID,
        "employeeId": "alice",  # pre-rename key, upgraded on read
        "displayName": "Alice's laptop",
        "workspacePath": "/workspace/alice",
        "workspaceId": "machine-alice",
        "nodeLocation": "employee-device",
        "sandboxMode": "none",
        "status": "ready",
        "capabilities": ["thread-workspaces", "generated-files"],
        "maxConcurrentRuns": 2,
        "agents": {"codex": "ready", "claude": "ready"},
        "disabledAgents": ["claude"],
        "agentRoleDefaults": {"codex": "planner"},
        "token": None,
        "nodeTokenHash": "sha256:node-hash",
        "uiTokenHash": "sha256:ui-hash",
        "createdAt": T0,
        "updatedAt": T1,
        "lastSeenAt": T1,
    })
    _write(daemon / "nodes" / f"{RETIRED_NODE_ID}.json", {
        "id": RETIRED_NODE_ID,
        "employeeId": "alice",
        "workspacePath": "/workspace/old",
        "status": "deleted",
        "retiredAt": T1,
        "capabilities": [],
        "agents": {},
        "token": None,
        "nodeTokenHash": "sha256:retired-hash",
        "createdAt": T0,
        "updatedAt": T1,
    })
    _write(daemon / "commands" / f"{COMMAND_ID}.json", {
        "id": COMMAND_ID,
        "nodeId": NODE_ID,
        "command": {"id": COMMAND_ID, "type": "run.start", "sessionId": SESSION_ID},
        "status": "queued",
        "attempt": 0,
        "createdAt": T0,
        "updatedAt": T0,
    })
    _write(daemon / "commands" / f"{WORKSPACE_COMMAND_ID}.json", {
        "id": WORKSPACE_COMMAND_ID,
        "nodeId": NODE_ID,
        "command": {"id": WORKSPACE_COMMAND_ID, "type": "workspace.list"},
        "status": "completed",
        "attempt": 1,
        "createdAt": T0,
        "updatedAt": T1,
        "completedAt": T1,
    })
    _write(daemon / "commands" / "orphan.json", {
        "id": "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        "nodeId": "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
        "command": {"type": "run.cancel"},
        "status": "queued",
        "createdAt": T0,
        "updatedAt": T0,
    })
    _write(daemon / "runs" / f"{RUN_ID}.json", {
        "runId": RUN_ID,
        "nodeId": NODE_ID,
        "commandId": COMMAND_ID,
        "sessionId": SESSION_ID,
        "agent": "codex",
        "taskGoal": "Ship it",
        "status": "running",
        "startedAt": T0,
    })
    _write(daemon / "run-requests" / f"{RUN_REQUEST_ID}.json", {
        "id": RUN_REQUEST_ID,
        "nodeId": NODE_ID,
        "sessionId": SESSION_ID,
        "taskGoal": "Ship it",
        "assignments": [{"executorKind": "codex", "mode": "action"}],
        "currentIndex": 0,
        "state": {},
        "status": "running",
        "currentCommandId": COMMAND_ID,
        "createdAt": T0,
        "updatedAt": T0,
    })
    _write_lines(daemon / "events" / "events.jsonl", [
        {"type": "daemon.node.registered", "timestamp": T0,
         "node": {"id": NODE_ID, "employeeId": "alice", "status": "ready"}},
        {"type": "daemon.command.enqueued", "timestamp": T0,
         "nodeId": NODE_ID, "commandId": COMMAND_ID},
        {"type": "daemon.workspace.response", "timestamp": T1, "nodeId": NODE_ID,
         "commandId": WORKSPACE_COMMAND_ID, "response": {"commandId": WORKSPACE_COMMAND_ID, "entries": []}},
    ])
    agent = {
        "id": AGENT_ID,
        "supervisorEmployeeId": "alice",
        "displayName": agent_name,
        "executorKind": "codex",
        "enabled": True,
        "version": 1,
        "createdAt": T0,
        "updatedAt": T0,
    }
    _write(root / "agents" / AGENT_ID / "snapshot.json", agent)
    _write_lines(root / "agents" / AGENT_ID / "events.jsonl", [
        {"id": "dddddddd-dddd-4ddd-8ddd-dddddddddddd", "type": "agent.created",
         "agentId": AGENT_ID, "timestamp": T0, "agent": agent},
    ])
    team = {
        "id": TEAM_ID,
        "ownerEmployeeId": "alice",
        "name": "Crew",
        "leadAgentId": AGENT_ID,
        "memberAgentIds": [AGENT_ID],
        "enabled": True,
        "createdAt": T0,
        "updatedAt": T0,
    }
    _write(root / "teams" / TEAM_ID / "snapshot.json", team)
    _write_lines(root / "teams" / TEAM_ID / "events.jsonl", [
        {"id": "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee", "type": "team.created",
         "teamId": TEAM_ID, "timestamp": T0, "team": team},
    ])
    placement = {
        "id": PLACEMENT_ID,
        "agentId": AGENT_ID,
        "supervisorEmployeeId": "alice",
        "daemonNodeId": NODE_ID,
        "executorKind": "codex",
        "desiredState": "active",
        "priority": 100,
        "agentVersion": 1,
        "createdAt": T0,
        "updatedAt": T0,
    }
    _write(root / "agent-placements" / PLACEMENT_ID / "snapshot.json", placement)
    _write_lines(root / "agent-placements" / PLACEMENT_ID / "events.jsonl", [
        {"id": "ffffffff-ffff-4fff-8fff-ffffffffffff", "type": "placement.created",
         "placementId": PLACEMENT_ID, "timestamp": T0, "placement": placement},
    ])
    chat = root / "chat"
    _write(chat / "integrations.json", [{
        "id": INTEGRATION_ID, "provider": "discord", "displayName": "Discord",
        "status": "draft", "config": {}, "identityLinks": [], "allowedConversations": [],
        "createdAt": T0, "updatedAt": T0,
    }])
    _write(chat / "secrets.json", {INTEGRATION_ID: {"botToken": "legacy-bot-token"}})
    _write(chat / "conversations.json", [{
        "key": "discord::::c1::", "provider": "discord", "conversationId": "c1",
        "sessionId": SESSION_ID, "ownerEmployeeId": "alice",
        "createdAt": T0, "updatedAt": T0,
    }])
    _write_lines(chat / "audit.jsonl", [{
        "id": "cae_1", "type": "chat.integration.created",
        "integrationId": INTEGRATION_ID, "actor": "admin", "timestamp": T0,
    }])


def _snapshot_tree(root: Path) -> dict[str, bytes]:
    return {
        str(path.relative_to(root)): path.read_bytes()
        for path in sorted(root.rglob("*"))
        if path.is_file()
    }


@pytest.fixture(autouse=True)
def chat_secret_key(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("RELAY_CHAT_SECRET_KEY", Fernet.generate_key().decode())


def test_imports_every_kind_of_record(tmp_path: Path) -> None:
    source = tmp_path / "data"
    write_legacy_tree(source)
    before = _snapshot_tree(source)
    database = tmp_path / "db"

    report = migrate_local_file_stores(source, sqlite_url(database))

    assert report["alreadyImported"] is False
    assert {key: report[key] for key in (
        "nodes", "commands", "runs", "runRequests", "daemonEvents",
        "agents", "teams", "placements", "chatDocuments",
    )} == {
        "nodes": 2, "commands": 2, "runs": 1, "runRequests": 1, "daemonEvents": 2,
        "agents": 1, "teams": 1, "placements": 1, "chatDocuments": 4,
    }
    assert report["skipped"] == {"commandsForMissingNode": 1, "prunableDaemonEvents": 1}
    # The source is never modified.
    assert _snapshot_tree(source) == before

    daemon = make_daemon_store(database)
    node = daemon.get_node(NODE_ID)
    assert node is not None
    assert node["userId"] == "alice"
    assert node["nodeLocation"] == "user-device"
    assert node["nodeTokenHash"] == "sha256:node-hash"
    assert node["uiTokenHash"] == "sha256:ui-hash"
    assert node["capabilities"] == ["thread-workspaces", "generated-files"]
    assert node["maxConcurrentRuns"] == 2
    assert node["agents"] == {"codex": "ready", "claude": "ready"}
    assert node["disabledAgents"] == ["claude"]
    assert node["agentRoleDefaults"] == {"codex": "planner"}
    retired = daemon.get_node(RETIRED_NODE_ID)
    assert retired is not None
    assert retired["status"] == "deleted"
    assert retired["retiredAt"] == T1
    assert daemon.queued_command_count(NODE_ID) == 1
    assert daemon.get_command(COMMAND_ID)["status"] == "queued"
    assert daemon.get_workspace_response(WORKSPACE_COMMAND_ID) == {
        "commandId": WORKSPACE_COMMAND_ID, "entries": [],
    }
    [run] = daemon.list_active_runs(NODE_ID)
    assert run["runId"] == RUN_ID and run["commandId"] == COMMAND_ID
    request = daemon.get_run_request(RUN_REQUEST_ID)
    assert request is not None and request["currentCommandId"] == COMMAND_ID

    agents = make_agent_store(database)
    agent = agents.get_agent(AGENT_ID)
    assert agent is not None
    assert agent["supervisorUserId"] == "alice"
    assert [event["type"] for event in agents.events(AGENT_ID)] == ["agent.created"]
    team = make_team_store(database).get_team(TEAM_ID)
    assert team is not None and team["ownerUserId"] == "alice"
    placements = make_agent_placement_store(database)
    placement = placements.get_placement(PLACEMENT_ID)
    assert placement is not None and placement["daemonNodeId"] == NODE_ID
    assert len(placements.events(PLACEMENT_ID)) == 1

    chat = make_chat_store(database)
    [integration] = chat.list_integrations()
    assert integration["secretConfigured"] is True
    assert chat.connection_settings(INTEGRATION_ID)["secrets"] == {"botToken": "legacy-bot-token"}
    assert [event["id"] for event in chat.audit_events()] == ["cae_1"]
    binding = chat.get_conversation_session(
        {"provider": "discord", "conversationId": "c1"}
    )
    assert binding is not None and binding["ownerUserId"] == "alice"


def test_second_import_is_a_no_op(tmp_path: Path) -> None:
    source = tmp_path / "data"
    write_legacy_tree(source)
    url = sqlite_url(tmp_path / "db")
    migrate_local_file_stores(source, url)

    again = migrate_local_file_stores(source, url)

    assert again["alreadyImported"] is True
    assert again["nodes"] == 0


def test_identical_rows_from_another_root_are_accepted(tmp_path: Path) -> None:
    url = sqlite_url(tmp_path / "db")
    write_legacy_tree(tmp_path / "first")
    write_legacy_tree(tmp_path / "copy")
    migrate_local_file_stores(tmp_path / "first", url)

    report = migrate_local_file_stores(tmp_path / "copy", url)

    assert report["alreadyImported"] is False
    assert report["daemonEvents"] == 0  # already present, not duplicated
    assert len(make_agent_store(tmp_path / "db").events(AGENT_ID)) == 1


def test_dry_run_writes_nothing(tmp_path: Path) -> None:
    source = tmp_path / "data"
    write_legacy_tree(source)
    database = tmp_path / "db"
    url = sqlite_url(database)

    report = migrate_local_file_stores(source, url, dry_run=True)

    assert report["dryRun"] is True
    assert report["nodes"] == 2 and report["agents"] == 1
    assert make_daemon_store(database).list_nodes() == []
    assert make_agent_store(database).get_agent(AGENT_ID) is None
    assert make_chat_store(database).list_integrations() == []
    # Without a marker, the real import still runs afterwards.
    assert migrate_local_file_stores(source, url)["nodes"] == 2


def test_conflicting_record_raises_and_writes_nothing(tmp_path: Path) -> None:
    url = sqlite_url(tmp_path / "db")
    write_legacy_tree(tmp_path / "first")
    migrate_local_file_stores(tmp_path / "first", url)
    write_legacy_tree(tmp_path / "second", agent_name="Someone else")
    extra = tmp_path / "second" / "teams" / "extra" / "snapshot.json"
    _write(extra, {
        "id": "12121212-1212-4212-8212-121212121212", "ownerUserId": "alice",
        "name": "Late team", "memberAgentIds": [], "createdAt": T0, "updatedAt": T0,
    })

    with pytest.raises(ValueError, match=f"agent {AGENT_ID}"):
        migrate_local_file_stores(tmp_path / "second", url)

    assert make_team_store(tmp_path / "db").get_team("12121212-1212-4212-8212-121212121212") is None
    assert make_agent_store(tmp_path / "db").get_agent(AGENT_ID)["displayName"] == "Builder"


def test_chat_secrets_need_the_encryption_key(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.delenv("RELAY_CHAT_SECRET_KEY")
    write_legacy_tree(tmp_path / "data")

    with pytest.raises(ValueError, match="RELAY_CHAT_SECRET_KEY"):
        migrate_local_file_stores(tmp_path / "data", sqlite_url(tmp_path / "db"))


def test_boot_imports_legacy_files_through_create_app(tmp_path: Path) -> None:
    source = tmp_path / "data"
    write_legacy_tree(source)
    assert local_file_stores_present(source)

    app = create_app(source)

    assert app.state.agent_store.get_agent(AGENT_ID)["displayName"] == "Builder"
    assert app.state.daemon_store.get_node(NODE_ID)["nodeTokenHash"] == "sha256:node-hash"
    assert app.state.team_store.get_team(TEAM_ID)["name"] == "Crew"
    # A restart finds the marker and imports nothing twice.
    restarted = create_app(source)
    assert len(restarted.state.agent_store.events(AGENT_ID)) == 1


def test_boot_fails_on_conflict_naming_the_cli(tmp_path: Path) -> None:
    write_legacy_tree(tmp_path / "first")
    migrate_local_file_stores(tmp_path / "first", os.environ["RELAY_DATABASE_URL"])
    write_legacy_tree(tmp_path / "second", agent_name="Someone else")

    with pytest.raises(RuntimeError, match="relay migrate-local-file-stores"):
        create_app(tmp_path / "second")


def test_empty_data_dir_has_nothing_to_import(tmp_path: Path) -> None:
    assert not local_file_stores_present(tmp_path)
