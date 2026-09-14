from __future__ import annotations

import base64

import pytest
from fastapi.testclient import TestClient
from relay.app import create_app


def bundle(name: str = "review", visibility: str = "private") -> dict:
    content = f"---\nname: {name}\ndescription: Reviews code\n---\nReview carefully.\n"
    return {
        "name": name,
        "description": "Reviews code",
        "visibility": visibility,
        "files": [{"path": "SKILL.md", "contentBase64": base64.b64encode(content.encode()).decode()}],
    }


def login(client: TestClient, name: str) -> None:
    client.post("/api/v1/auth/logout")
    response = client.post("/api/v1/auth/login", json={"username": name, "password": "userpass"})
    assert response.status_code == 200, response.text


@pytest.fixture
def client(monkeypatch, tmp_path):
    monkeypatch.setenv("RELAY_ADMIN_TOKEN", "admin_token")
    app = create_app(tmp_path)
    with TestClient(app) as client:
        assert client.post("/api/v1/auth/bootstrap", json={
            "token": "admin_token", "username": "admin", "password": "kestrel-vault-7719",
        }).status_code == 200
        for name in ("alice", "bob"):
            assert client.post("/api/v1/admin/employees", json={
                "employeeId": name, "username": name, "password": "userpass", "displayName": name,
            }).status_code == 201
        login(client, "alice")
        yield client


def publish(client: TestClient, **kwargs) -> dict:
    response = client.post("/api/v1/skills", json=bundle(**kwargs))
    assert response.status_code == 201, response.text
    return response.json()


def test_publish_list_detail_revision_and_delete(client):
    skill = publish(client)
    assert skill["ownerEmployeeId"] == "alice"
    assert skill["slug"] == "review"
    assert [item["id"] for item in client.get("/api/v1/skills").json()["skills"]] == [skill["id"]]
    url = f"/api/v1/skills/{skill['id']}"
    detail = client.get(url).json()
    assert detail["revisions"][0]["revision"] == 1
    assert detail["files"][0]["path"] == "SKILL.md"
    assert "content" not in detail["files"][0]
    assert "contentBase64" not in detail["files"][0]
    first = skill["currentRevisionId"]
    response = client.post(f"{url}/revisions", json={"files": bundle()["files"], "note": "second"})
    assert response.status_code == 201, response.text
    detail = client.get(url).json()
    assert [revision["revision"] for revision in detail["revisions"]] == [2, 1]
    assert detail["currentRevisionId"] != first
    assert client.patch(url, json={"displayName": "Code review", "visibility": "org"}).status_code == 200
    assert client.get(url).json()["displayName"] == "Code review"
    assert client.delete(url).status_code == 204
    assert client.get(url).status_code == 404
    assert client.get("/api/v1/skills").json()["skills"] == []


def test_private_skill_does_not_leak_and_shared_skill_is_owner_mutable(client):
    private = publish(client, name="secret")
    shared = publish(client, name="shared", visibility="org")
    login(client, "bob")
    assert [item["id"] for item in client.get("/api/v1/skills").json()["skills"]] == [shared["id"]]
    for skill, expected in ((private, 404), (shared, 403)):
        url = f"/api/v1/skills/{skill['id']}"
        assert client.get(url).status_code == (404 if expected == 404 else 200)
        assert client.patch(url, json={"displayName": "stolen"}).status_code == expected
        assert client.delete(url).status_code == expected
        assert client.post(f"{url}/revisions", json={"files": bundle()["files"]}).status_code == expected


@pytest.mark.parametrize("mutation,expected", [
    ({"files": [{"path": "SKILL.md", "contentBase64": "not base64!"}]}, 422),
    ({"files": [{"path": "SKILL.md", "contentBase64": 42}]}, 422),
    ({"files": "wrong"}, 422),
    ({"files": [{"path": "SKILL.md", "contentBase64": base64.b64encode(b"x" * 1_048_577).decode()}]}, 413),
    ({"files": [{"path": "SKILL.md", "contentBase64": "eA=="}]}, 422),
    ({"visibility": "everyone"}, 422),
    ({"source": "git", "sourceRef": {"url": "https://github.com/o/r"}}, 422),
])
def test_invalid_publish_is_atomic(client, mutation, expected):
    response = client.post("/api/v1/skills", json={**bundle(), **mutation})
    assert response.status_code == expected, response.text
    assert client.get("/api/v1/skills").json()["skills"] == []


def test_caller_cannot_override_owner_or_identity(client):
    response = client.post("/api/v1/skills", json={**bundle(), "ownerEmployeeId": "bob"})
    assert response.status_code == 422
    skill = publish(client)
    url = f"/api/v1/skills/{skill['id']}"
    assert client.patch(url, json={"ownerEmployeeId": "bob", "slug": "other"}).status_code == 422
    assert client.get(url).json()["ownerEmployeeId"] == "alice"


def test_skill_routes_require_login(client):
    skill = publish(client)
    client.post("/api/v1/auth/logout")
    assert client.get("/api/v1/skills").status_code == 401
    assert client.post("/api/v1/skills", json=bundle()).status_code == 401
    assert client.get(f"/api/v1/skills/{skill['id']}").status_code == 401


def test_import_allowlist_is_admin_only_and_preserves_other_settings(client):
    assert client.put("/api/v1/admin/settings", json={"skillImportAllowedHosts": []}).status_code == 403
    client.post("/api/v1/auth/logout")
    assert client.post("/api/v1/auth/login", json={"username": "admin", "password": "kestrel-vault-7719"}).status_code == 200
    response = client.put("/api/v1/admin/settings", json={"skillImportAllowedHosts": []})
    assert response.status_code == 200, response.text
    assert response.json()["settings"]["skillImportAllowedHosts"] == []
    response = client.put("/api/v1/admin/settings", json={"maxTaskRounds": 9})
    assert response.json()["settings"]["skillImportAllowedHosts"] == []
    assert client.put("/api/v1/admin/settings", json={"skillImportAllowedHosts": None}).status_code == 400


def test_import_and_reimport_create_immutable_revisions(client, monkeypatch):
    calls = []
    def fetch(url, ref, subpath, *, allowed_hosts, **kwargs):
        calls.append((url, ref, subpath, allowed_hosts))
        return [{"path": "SKILL.md", "content": base64.b64decode(bundle()["files"][0]["contentBase64"])}]
    monkeypatch.setattr("relay.services.skill_import.fetch_skill_bundle", fetch)
    payload = {"name": "review", "description": "Reviews code", "visibility": "org",
               "url": "https://github.com/example/skills", "ref": "main", "subpath": "review"}
    response = client.post("/api/v1/skills/import", json=payload)
    assert response.status_code == 201, response.text
    skill = response.json()
    assert skill["source"] == "git"
    assert skill["sourceRef"] == {key: payload[key] for key in ("url", "ref", "subpath")}
    url = f"/api/v1/skills/{skill['id']}"
    assert client.post(f"{url}/import").status_code == 201
    assert len(client.get(url).json()["revisions"]) == 2
    assert calls == [(payload["url"], "main", "review", ["github.com"])] * 2
    login(client, "bob")
    assert client.post(f"{url}/import").status_code == 403
    assert len(calls) == 2


def test_import_failure_does_not_publish(client, monkeypatch):
    from relay.services.skill_import import SkillImportError
    def fail(*args, **kwargs):
        raise SkillImportError("host-not-allowed")
    monkeypatch.setattr("relay.services.skill_import.fetch_skill_bundle", fail)
    response = client.post("/api/v1/skills/import", json={
        "name": "review", "description": "d", "url": "https://example.com/o/r", "ref": "main",
    })
    assert response.status_code == 422, response.text
    assert response.json()["detail"] == "host-not-allowed"
    assert client.get("/api/v1/skills").json()["skills"] == []


def create_agent(client, owner="alice", executor="claude", name="Reviewer", supports_skills=True):
    from relay.core.computer_identity import computer_id
    node = client.app.state.registry.register({
        "sandboxId": f"skill-node-{owner}", "employeeId": owner, "token": f"skill-token-{owner}",
        "protocolVersion": 1, "supportedAgents": ["claude", "codex"],
        "capabilities": ["thread-workspaces", *(["agent-skills"] if supports_skills else [])], "status": "ready",
        "workspacePath": "/workspace/skills", "workspaceId": f"skill-machine-{owner}",
        "agentInventory": {executor: {"skills": [{"name": "local", "description": "Installed locally"}], "mcpServers": []}},
    })
    client.post("/api/v1/auth/logout")
    assert client.post("/api/v1/auth/login", json={"username": "admin", "password": "kestrel-vault-7719"}).status_code == 200
    response = client.post("/api/v1/admin/agents", json={
        "supervisorEmployeeId": owner, "displayName": name, "executorKind": executor,
        "defaultRole": "implementer", "computerId": computer_id(node),
    })
    assert response.status_code == 201, response.text
    login(client, "alice")
    return response.json()["agent"], node


def test_grant_codex_and_merged_agent_view_then_revoke(client):
    agent, _ = create_agent(client, executor="codex")
    skill = publish(client)
    url = f"/api/v1/skills/{skill['id']}/grants"
    response = client.post(url, json={"agentIds": [agent["id"]]})
    assert response.status_code == 200, response.text
    detail = next(item for item in client.get("/api/v1/agents").json()["agents"] if item["id"] == agent["id"])
    assert any(item["source"] == "node" and item["name"] == "local" for item in detail["skills"])
    catalog = [item for item in detail["skills"] if item["source"] == "catalog"]
    assert catalog[0]["skillId"] == skill["id"]
    assert catalog[0]["available"] is True
    assert client.delete(f"/api/v1/skills/{skill['id']}").status_code == 204
    detail = next(item for item in client.get("/api/v1/agents").json()["agents"] if item["id"] == agent["id"])
    assert next(item for item in detail["skills"] if item["source"] == "catalog")["available"] is False
    assert client.delete(f"{url}/{agent['id']}").status_code == 204
    detail = next(item for item in client.get("/api/v1/agents").json()["agents"] if item["id"] == agent["id"])
    assert all(item["source"] != "catalog" for item in detail["skills"])


def test_grant_fanout_checks_all_owners_before_writing(client):
    own, _ = create_agent(client)
    other, _ = create_agent(client, owner="bob")
    skill = publish(client, visibility="org")
    response = client.post(f"/api/v1/skills/{skill['id']}/grants", json={"agentIds": [own["id"], other["id"]]})
    assert response.status_code == 403, response.text
    assert client.app.state.agent_store.get_agent(own["id"])["skillPolicy"] == {}


def test_generic_agent_patch_cannot_bypass_grant_authorization(client):
    agent, _ = create_agent(client)
    response = client.patch(f"/api/v1/agents/{agent['id']}", json={
        "skillPolicy": {"version": 1, "grants": [{"skillId": "stolen", "pin": "latest"}]},
    })
    assert response.status_code == 400, response.text
    client.post("/api/v1/auth/logout")
    client.post("/api/v1/auth/login", json={"username": "admin", "password": "kestrel-vault-7719"})
    response = client.patch(f"/api/v1/admin/agents/{agent['id']}", json={"skillPolicy": {"version": 1, "grants": []}})
    assert response.status_code == 422, response.text


@pytest.mark.parametrize("supports_skills", [True, False])
def test_publish_grant_dispatch_delivers_manifest_or_explicit_notice(client, supports_skills):
    agent, node = create_agent(client, executor="codex", supports_skills=supports_skills)
    skill = publish(client)
    assert client.post(f"/api/v1/skills/{skill['id']}/grants", json={"agentIds": [agent["id"]]}).status_code == 200
    response = client.post("/api/v1/agent-runs", json={"taskGoal": "Review the workspace", "assignments": [{"agentId": agent["id"]}]})
    assert response.status_code == 202, response.text
    commands = client.app.state.registry.take_commands(node["id"], "skill-token-alice")
    command = next(item for item in commands if item["type"] == "run.start")
    assert command["logicalAgentId"] == agent["id"]
    if supports_skills:
        entry = command["skills"]["skills"][0]
        assert entry["skillId"] == skill["id"]
        assert entry["revisionId"] == skill["currentRevisionId"]
        assert set(entry["files"][0]) == {"path", "sha256", "bytes"}
        sha = entry["files"][0]["sha256"]
        blob = client.get(f"/api/v1/daemon-nodes/{node['id']}/skill-blobs/{sha}?commandId={command['id']}", headers={"Authorization": "Bearer skill-token-alice"})
        assert blob.status_code == 200, blob.text
        assert blob.content == base64.b64decode(bundle()["files"][0]["contentBase64"])
    else:
        assert "skills" not in command
        session = client.app.state.session_store.get_session(command["sessionId"])
        notices = [event for event in session["events"] if event["type"] == "system.notice"]
        assert len(notices) == 1
        assert "review" in notices[0]["text"]
        assert notices[0]["skillsSkipped"][0]["reason"] == "daemon-unsupported"


def test_same_node_agents_receive_only_their_own_catalog_grants(client):
    granted, node = create_agent(client, name="Granted reviewer")
    ungranted, _ = create_agent(client, name="Other reviewer")
    client.app.state.registry.update_status(node["id"], {"maxConcurrentRuns": 2})
    skill = publish(client)
    assert client.post(f"/api/v1/skills/{skill['id']}/grants", json={"agentIds": [granted["id"]]}).status_code == 200
    for agent in (granted, ungranted):
        response = client.post("/api/v1/agent-runs", json={
            "taskGoal": "Review the workspace", "assignments": [{"agentId": agent["id"]}],
        })
        assert response.status_code == 202, response.text
    commands = {
        command["logicalAgentId"]: command
        for command in client.app.state.registry.take_commands(node["id"], "skill-token-alice")
        if command["type"] == "run.start"
    }
    assert commands[granted["id"]]["skills"]["skills"][0]["skillId"] == skill["id"]
    assert "skills" not in commands[ungranted["id"]]
    sha = commands[granted["id"]]["skills"]["skills"][0]["files"][0]["sha256"]
    response = client.get(
        f"/api/v1/daemon-nodes/{node['id']}/skill-blobs/{sha}?commandId={commands[ungranted['id']]['id']}",
        headers={"Authorization": "Bearer skill-token-alice"},
    )
    assert response.status_code == 404, response.text
