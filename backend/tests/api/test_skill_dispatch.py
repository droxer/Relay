from __future__ import annotations

from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient
from relay.api.helpers import daemon_node_event
from relay.app import create_app
from relay.daemon_registry.registry import DaemonNodeRegistry


def _node(registry, node_id, token):
    return registry.register(
        {
            "sandboxId": node_id,
            "token": token,
            "protocolVersion": 1,
            "supportedAgents": ["codex"],
            "capabilities": ["agent-skills"],
            "status": "ready",
            "workspacePath": f"/workspace/{node_id}",
        }
    )


def test_blob_is_scoped_to_active_issuing_node_command(monkeypatch, tmp_path):
    monkeypatch.setenv("RELAY_ADMIN_TOKEN", "admin_token")
    app = create_app(tmp_path)
    app.state.skill_store = SimpleNamespace(
        blob=lambda digest: b"content" if digest == "allowed" else None
    )
    registry = app.state.registry
    first = _node(registry, "node-first", "token-first")
    second = _node(registry, "node-second", "token-second")
    command = {
        "id": "skill-command",
        "type": "run.start",
        "sessionId": "session",
        "runId": "run",
        "agent": "codex",
        "taskGoal": "test",
        "skills": {
            "contract": {"name": "relay.agent.skills", "version": 1},
            "skills": [
                {
                    "skillId": "skill",
                    "revisionId": "revision",
                    "slug": "review",
                    "manifestSha256": "manifest",
                    "files": [{"path": "SKILL.md", "sha256": "allowed", "bytes": 7}],
                }
            ],
        },
    }
    record = {
        "id": command["id"],
        "nodeId": first["id"],
        "status": "dispatched",
        "command": command,
    }
    app.state.daemon_store.get_command = lambda command_id: (
        record if command_id == command["id"] else None
    )
    url = f"/api/v1/daemon-nodes/{first['id']}/skill-blobs/allowed?commandId=skill-command"
    with TestClient(app) as client:
        assert client.get(url).status_code == 401
        response = client.get(url, headers={"Authorization": "Bearer token-first"})
        assert response.status_code == 200 and response.content == b"content"
        assert response.headers["content-type"] == "application/octet-stream"
        assert (
            client.get(
                url, headers={"Authorization": "Bearer token-second"}
            ).status_code
            == 401
        )
        cross = url.replace(first["id"], second["id"])
        assert (
            client.get(
                cross, headers={"Authorization": "Bearer token-second"}
            ).status_code
            == 404
        )
        absent = url.replace("/allowed?", "/absent?")
        assert (
            client.get(
                absent, headers={"Authorization": "Bearer token-first"}
            ).status_code
            == 404
        )


def test_run_executing_skill_skip_parser_matches_protocol_and_bounds_fields():
    base = {
        "type": "run.executing",
        "commandId": "command",
        "sessionId": "session",
        "runId": "run",
        "agent": "codex",
    }
    parsed = daemon_node_event(
        {
            **base,
            "skillsSkipped": [
                {"skillId": "skill", "slug": "review", "reason": "write-failed"}
            ],
        }
    )
    assert parsed["skillsSkipped"][0]["slug"] == "review"
    assert len(daemon_node_event(
            {
                **base,
                "skillsSkipped": [
                    {"skillId": str(i), "slug": "s", "reason": "r"} for i in range(101)
                ],
            }
        )["skillsSkipped"]) == 101
    assert daemon_node_event({**base, "skillsSkipped": [{"skillId": "skill", "reason": "invalid-bundle"}]})["skillsSkipped"] == [{"skillId": "skill", "reason": "invalid-bundle"}]
    with pytest.raises(ValueError):
        daemon_node_event(
            {
                **base,
                "skillsSkipped": [
                    {"skillId": "skill", "slug": "s", "reason": "x" * 201}
                ],
            }
        )


class _SessionStore:
    def __init__(self):
        self.session = {"id": "session", "events": []}

    def get_session(self, session_id):
        return self.session

    def append_event(self, session_id, event, **kwargs):
        self.session["events"].append(event)
        return self.session


def test_skipped_notice_accepts_only_command_skills_and_is_idempotent():
    store = _SessionStore()
    registry = object.__new__(DaemonNodeRegistry)
    registry.store = store
    command = {
        "sessionId": "session",
        "runId": "run",
        "agent": "codex",
        "skills": {"skills": [{"skillId": "allowed", "slug": "review"}]},
        "_skillsSkipped": [{"skillId": "backend", "slug": "gone", "reason": "deleted"}],
    }
    reported = [
        {"skillId": "allowed", "reason": "write-failed"},
        {"skillId": "allowed", "slug": "review", "reason": "another-error"},
        {"skillId": "allowed", "slug": "forged-slug", "reason": "write-failed"},
        {"skillId": "foreign", "slug": "stolen", "reason": "write-failed"},
    ]
    registry._record_skipped_skills(command, reported)
    registry._record_skipped_skills(command, reported)
    notices = [
        event for event in store.session["events"] if event["type"] == "system.notice"
    ]
    assert len(notices) == 1
    assert {item["skillId"] for item in notices[0]["skillsSkipped"]} == {
        "allowed",
        "backend",
    }
    assert notices[0]["reason"] == "skills-skipped"
    assert len(notices[0]["skillsSkipped"]) == 2
    assert next(item for item in notices[0]["skillsSkipped"] if item["skillId"] == "allowed")["slug"] == "review"
