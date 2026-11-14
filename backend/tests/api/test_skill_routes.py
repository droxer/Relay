from __future__ import annotations

import base64
import io
import tarfile
import zipfile

import pytest
from fastapi.testclient import TestClient
from relay.app import create_app
from relay.skills.bundle import resolve_bundle

from user_ids import user_id

ALICE = user_id("alice")
BOB = user_id("bob")


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
            "token": "admin_token", "username": "admin", "email": "admin@example.com", "password": "kestrel-vault-7719",
        }).status_code == 200
        for name in ("alice", "bob"):
            assert client.post("/api/v1/admin/users", json={
                "userId": name, "username": name, "email": f"{name}@example.com", "password": "userpass", "displayName": name,
            }).status_code == 201
        login(client, "alice")
        yield client


def publish(client: TestClient, **kwargs) -> dict:
    response = client.post("/api/v1/skills", json=bundle(**kwargs))
    assert response.status_code == 201, response.text
    return response.json()


def test_publish_list_detail_revision_and_delete(client):
    skill = publish(client)
    assert skill["ownerUserId"] == ALICE
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
    assert client.patch(url, json={"displayName": "Code review", "visibility": "public"}).status_code == 200
    assert client.get(url).json()["displayName"] == "Code review"
    assert client.delete(url).status_code == 204
    assert client.get(url).status_code == 404
    assert client.get("/api/v1/skills").json()["skills"] == []


def test_private_skill_does_not_leak_and_shared_skill_is_owner_mutable(client):
    private = publish(client, name="secret")
    shared = publish(client, name="shared", visibility="public")
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
    response = client.post("/api/v1/skills", json={**bundle(), "ownerUserId": BOB})
    assert response.status_code == 422
    skill = publish(client)
    url = f"/api/v1/skills/{skill['id']}"
    assert client.patch(url, json={"ownerUserId": BOB, "slug": "other"}).status_code == 422
    assert client.get(url).json()["ownerUserId"] == ALICE


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


@pytest.mark.parametrize("subpath", ["skills/foo+bar", "skills/审查", "@scope/code-review", "skills/team review"])
def test_discovered_skill_paths_support_explicit_import_and_reimport(client, monkeypatch, subpath):
    content = base64.b64decode(bundle()["files"][0]["contentBase64"])
    compressed = io.BytesIO()
    with tarfile.open(fileobj=compressed, mode="w:gz") as archive:
        member = tarfile.TarInfo(f"tools-main/{subpath}/SKILL.md")
        member.size = len(content)
        archive.addfile(member, io.BytesIO(content))
    data = compressed.getvalue()
    monkeypatch.setattr("relay.skills.git_import._resolve_host", lambda host: ["140.82.112.10"])
    monkeypatch.setattr("relay.skills.git_import._download_archive", lambda *args: (200, {}, iter([data])))
    source = {"url": "https://github.com/acme/tools", "ref": "main"}
    response = client.post("/api/v1/skills/import", json=source)
    assert response.status_code == 201, response.text
    skill = response.json()["skills"][0]
    assert skill["sourceRef"]["subpath"] == subpath
    reimported = client.post(f"/api/v1/skills/{skill['id']}/import")
    assert reimported.status_code == 201, reimported.text
    assert len(client.get(f"/api/v1/skills/{skill['id']}").json()["revisions"]) == 2
    explicit = client.post("/api/v1/skills/import", json={**source, "namespace": "explicit", "subpath": subpath})
    assert explicit.status_code == 201, explicit.text
    assert explicit.json()["sourceRef"]["subpath"] == subpath


def test_empty_directory_imports_separate_skills_and_reports_invalid_entries(client, monkeypatch):
    def files(name):
        return [{"path": "SKILL.md", "content": base64.b64decode(bundle(name)["files"][0]["contentBase64"])}]

    entries = [
        {"subpath": "skills/review", "files": files("review")},
        {"subpath": "skills/triage", "files": files("triage")},
        {"subpath": "skills/invalid", "files": [{"path": "SKILL.md", "content": b"not frontmatter"}]},
        {"subpath": "skills/unsafe", "error": "unsafe-archive"},
    ]
    monkeypatch.setattr("relay.skills.git_import.fetch_skill_repository", lambda *a, **k: entries)
    payload = {"url": "https://github.com/example/skills", "ref": "main", "visibility": "public", "namespace": "team"}
    response = client.post("/api/v1/skills/import", json=payload)
    assert response.status_code == 201, response.text
    result = response.json()
    assert [item["name"] for item in result["skills"]] == ["review", "triage"]
    assert [item["sourceRef"]["subpath"] for item in result["skills"]] == ["skills/review", "skills/triage"]
    assert all(item["ownerUserId"] == ALICE and item["namespace"] == "team" and item["visibility"] == "public" for item in result["skills"])
    assert {item["subpath"]: item["code"] for item in result["failed"]} == {
        "skills/invalid": "invalid-skill-md", "skills/unsafe": "unsafe-archive",
    }
    retry = client.post("/api/v1/skills/import", json=payload)
    assert retry.status_code == 200, retry.text
    assert retry.json()["skills"] == []
    assert len(client.get("/api/v1/skills").json()["skills"]) == 2
    assert sum(item["code"] == "skill-name-taken" for item in retry.json()["failed"]) == 2

    seen = []
    def reimport(url, ref, subpath, **kwargs):
        seen.append(subpath)
        return files("review")
    monkeypatch.setattr("relay.skills.git_import.fetch_skill_bundle", reimport)
    assert client.post(f"/api/v1/skills/{result['skills'][0]['id']}/import").status_code == 201
    assert seen == ["skills/review"]


@pytest.mark.parametrize("provide_name", [True, False])
def test_import_and_reimport_create_immutable_revisions(client, monkeypatch, provide_name):
    calls = []
    def fetch(url, ref, subpath, *, allowed_hosts, **kwargs):
        calls.append((url, ref, subpath, allowed_hosts))
        return [{"path": "SKILL.md", "content": base64.b64decode(bundle()["files"][0]["contentBase64"])}]
    monkeypatch.setattr("relay.skills.git_import.fetch_skill_bundle", fetch)
    payload = {"name": "review", "description": "Reviews code", "visibility": "public",
               "url": "https://github.com/example/skills", "ref": "main", "subpath": "review"}
    if not provide_name:
        payload.pop("name")
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


@pytest.mark.parametrize("code", ["host-not-allowed", "no-skills-found"])
def test_import_failure_does_not_publish(client, monkeypatch, code):
    from relay.skills.git_import import SkillImportError
    def fail(*args, **kwargs):
        raise SkillImportError(code)
    monkeypatch.setattr("relay.skills.git_import.fetch_skill_bundle", fail)
    monkeypatch.setattr("relay.skills.git_import.fetch_skill_repository", fail)
    response = client.post("/api/v1/skills/import", json={
        "name": "review", "description": "d", "url": "https://example.com/o/r", "ref": "main",
    })
    assert response.status_code == 422, response.text
    assert response.json()["detail"] == code
    assert client.get("/api/v1/skills").json()["skills"] == []


def create_agent(client, owner="alice", executor="claude", name="Reviewer", supports_skills=True):
    from relay.core.computer_identity import computer_id
    node = client.app.state.registry.register({
        "sandboxId": f"skill-node-{owner}", "userId": user_id(owner), "token": f"skill-token-{owner}",
        "protocolVersion": 1, "supportedAgents": ["claude", "codex"],
        "capabilities": ["workspace-scope", "thread-workspaces", *(["agent-skills"] if supports_skills else [])], "status": "ready",
        "workspacePath": "/workspace/skills", "workspaceId": f"skill-machine-{owner}",
        "agentInventory": {executor: {"skills": [{"name": "local", "description": "Installed locally"}], "mcpServers": []}},
    })
    client.post("/api/v1/auth/logout")
    assert client.post("/api/v1/auth/login", json={"username": "admin", "password": "kestrel-vault-7719"}).status_code == 200
    response = client.post("/api/v1/admin/agents", json={
        "supervisorUserId": user_id(owner), "displayName": name, "executorKind": executor,
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


@pytest.mark.parametrize("scope", ["user", "agent"])
def test_scoped_assignment_is_visible_on_agent_skills_page(client, scope):
    agent, _ = create_agent(client)
    skill = publish(client)
    response = client.post(f"/api/v1/skills/{skill['id']}/assignments", json={
        "targetType": scope, "targetId": ALICE if scope == "user" else agent["id"],
        "mode": "optional", "pin": "stable", "invocation": "implicit",
    })
    assert response.status_code == 201, response.text
    assignment = response.json()

    def catalog():
        agents = client.get("/api/v1/agents").json()["agents"]
        detail = next(item for item in agents if item["id"] == agent["id"])
        return [item for item in detail["skills"] if item["source"] == "catalog"]

    entries = catalog()
    assert [entry["skillId"] for entry in entries] == [skill["id"]]
    assert entries[0]["available"] is True
    assert entries[0]["pin"] == "stable"
    assert entries[0]["assignmentId"] == assignment["id"]
    assert entries[0]["inherited"] is (scope != "agent")
    # The legacy direct grant wins without duplicating the scoped assignment.
    assert client.post(f"/api/v1/skills/{skill['id']}/grants", json={
        "agentIds": [agent["id"]], "pin": "latest",
    }).status_code == 200
    assert len(catalog()) == 1
    assert catalog()[0]["pin"] == "latest"
    assert "assignmentId" not in catalog()[0]
    assert client.delete(f"/api/v1/skills/{skill['id']}/grants/{agent['id']}").status_code == 204
    assert catalog()[0]["pin"] == "stable"
    assert client.delete(f"/api/v1/skills/{skill['id']}").status_code == 204
    assert catalog()[0]["available"] is False
    assert catalog()[0]["reason"] == "deleted"


@pytest.mark.parametrize("scope", ["org", "agent"])
@pytest.mark.parametrize("initial_visibility", ["private", "public"])
def test_agent_skills_redact_other_owners_private_publication(client, scope, initial_visibility):
    agent, _ = create_agent(client)
    client.post("/api/v1/auth/logout")
    assert client.post("/api/v1/auth/login", json={
        "username": "admin", "password": "kestrel-vault-7719",
    }).status_code == 200
    response = client.post("/api/v1/skills", json={
        **bundle("admin-secret", visibility=initial_visibility), "namespace": "confidential",
    })
    assert response.status_code == 201, response.text
    skill = response.json()
    url = f"/api/v1/skills/{skill['id']}"
    response = client.post(f"{url}/assignments", json={
        "targetType": scope,
        "targetId": "org" if scope == "org" else agent["id"],
    })
    assert response.status_code == 201, response.text
    assignment = response.json()

    def catalog():
        agents = client.get("/api/v1/agents").json()["agents"]
        detail = next(item for item in agents if item["id"] == agent["id"])
        return next(item for item in detail["skills"] if item.get("skillId") == skill["id"])

    if initial_visibility == "public":
        login(client, "alice")
        assert catalog()["name"] == "admin-secret"
        assert catalog()["available"] is True
        client.post("/api/v1/auth/logout")
        assert client.post("/api/v1/auth/login", json={
            "username": "admin", "password": "kestrel-vault-7719",
        }).status_code == 200
        assert client.patch(url, json={"visibility": "private"}).status_code == 200

    login(client, "alice")
    assert client.get(url).status_code == 404
    assert client.get("/api/v1/skills").json()["skills"] == []
    assert catalog() == {
        "source": "catalog", "skillId": skill["id"], "name": skill["id"],
        "namespace": None, "description": "", "slug": skill["id"],
        "available": False, "pin": "stable", "reason": "visibility-revoked",
        "assignmentId": assignment["id"], "inherited": scope != "agent",
    }


def test_grant_fanout_checks_all_owners_before_writing(client):
    own, _ = create_agent(client)
    other, _ = create_agent(client, owner="bob")
    skill = publish(client, visibility="public")
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
@pytest.mark.parametrize("empty_file", [True, False])
def test_publish_grant_dispatch_delivers_manifest_or_explicit_notice(client, supports_skills, empty_file):
    agent, node = create_agent(client, executor="codex", supports_skills=supports_skills)
    payload = bundle()
    if empty_file:
        payload["files"].append({"path": "scripts/empty.py", "contentBase64": ""})
    published = client.post("/api/v1/skills", json=payload)
    assert published.status_code == 201, published.text
    skill = published.json()
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
        for file, expected in zip(entry["files"], payload["files"], strict=True):
            sha = file["sha256"]
            blob = client.get(f"/api/v1/daemon-nodes/{node['id']}/skill-blobs/{sha}?commandId={command['id']}", headers={"Authorization": "Bearer skill-token-alice"})
            assert blob.status_code == 200, blob.text
            assert blob.content == base64.b64decode(expected["contentBase64"])
        exported = client.get(f"/api/v1/skills/{skill['id']}/export")
        assert exported.status_code == 200, exported.text
        with zipfile.ZipFile(io.BytesIO(exported.content)) as archive:
            for file in payload["files"]:
                assert archive.read(file["path"]) == base64.b64decode(file["contentBase64"])
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


def test_user_assignment_dynamically_delivers_to_current_and_future_agents(client):
    first, node = create_agent(client, name="First reviewer")
    skill = publish(client, visibility="public")
    response = client.post(
        f"/api/v1/skills/{skill['id']}/assignments",
        json={
            "targetType": "user",
            "targetId": ALICE,
            "mode": "optional",
            "pin": "stable",
            "invocation": "implicit",
        },
    )
    assert response.status_code == 201, response.text
    assignment = response.json()
    assert assignment["targetType"] == "user"
    detail = client.get(f"/api/v1/skills/{skill['id']}").json()
    assert detail["assignments"] == [assignment]

    second, _ = create_agent(client, name="Future reviewer")
    client.app.state.registry.update_status(node["id"], {"maxConcurrentRuns": 2})
    for agent in (first, second):
        response = client.post(
            "/api/v1/agent-runs",
            json={
                "taskGoal": "Review the workspace",
                "assignments": [{"agentId": agent["id"]}],
            },
        )
        assert response.status_code == 202, response.text
    commands = [
        command
        for command in client.app.state.registry.take_commands(
            node["id"], "skill-token-alice"
        )
        if command["type"] == "run.start"
    ]
    assert len(commands) == 2
    assert all(
        command["skills"]["skills"][0]["skillId"] == skill["id"]
        for command in commands
    )

    assert client.delete(
        f"/api/v1/skills/{skill['id']}/assignments/{assignment['id']}"
    ).status_code == 204
    assert client.get(f"/api/v1/skills/{skill['id']}").json()["assignments"] == []


def test_assignment_api_prevents_cross_user_targeting(client):
    skill = publish(client, visibility="public")
    response = client.post(
        f"/api/v1/skills/{skill['id']}/assignments",
        json={"targetType": "user", "targetId": BOB},
    )
    assert response.status_code == 403, response.text
    assert response.json()["detail"] == "not-target-owner"


def test_assignment_api_rejects_unknown_fields_and_invalid_policy(client):
    skill = publish(client)
    url = f"/api/v1/skills/{skill['id']}/assignments"
    assert client.post(
        url,
        json={"targetType": "user", "targetId": ALICE, "unexpected": True},
    ).status_code == 422
    response = client.post(
        url,
        json={
            "targetType": "user",
            "targetId": ALICE,
            "mode": "suggested",
            "invocation": "implicit",
        },
    )
    assert response.status_code == 422
    assert response.json()["detail"] == "suggested-requires-explicit-invocation"


def test_owner_can_promote_and_export_a_portable_skill_bundle(client):
    skill = publish(client, name="portable")
    agent, _ = create_agent(client)
    assigned = client.post(f"/api/v1/skills/{skill['id']}/assignments", json={
        "targetType": "agent", "targetId": agent["id"], "pin": "stable",
    })
    assert assigned.status_code == 201, assigned.text
    first_revision = skill["currentRevisionId"]
    revised = client.post(
        f"/api/v1/skills/{skill['id']}/revisions",
        json={
            "files": [
                {
                    "path": "SKILL.md",
                    "contentBase64": base64.b64encode(
                        b"---\nname: portable\ndescription: Portable\n---\nsecond"
                    ).decode(),
                }
            ]
        },
    )
    assert revised.status_code == 201, revised.text
    second_revision = revised.json()["currentRevisionId"]

    detail = client.get(f"/api/v1/skills/{skill['id']}").json()
    assert detail["stableRevisionId"] == first_revision
    before, _ = resolve_bundle(client.app.state.context, agent)
    assert before["skills"][0]["revisionId"] == first_revision
    promoted = client.post(
        f"/api/v1/skills/{skill['id']}/revisions/{second_revision}/promote",
        json={},
    )
    assert promoted.status_code == 200, promoted.text
    assert promoted.json()["stableRevisionId"] == second_revision
    after, _ = resolve_bundle(client.app.state.context, agent)
    assert after["skills"][0]["revisionId"] == second_revision

    exported = client.get(
        f"/api/v1/skills/{skill['id']}/export?channel=stable"
    )
    assert exported.status_code == 200, exported.text
    assert exported.headers["content-type"] == "application/zip"
    assert "portable.skill.zip" in exported.headers["content-disposition"]
    with zipfile.ZipFile(io.BytesIO(exported.content)) as archive:
        assert archive.namelist() == ["SKILL.md"]
        assert archive.read("SKILL.md").endswith(b"second")


def test_viewer_can_preview_a_skill_file_without_downloading_the_bundle(client):
    skill = publish(client, name="previewable", visibility="public")
    url = f"/api/v1/skills/{skill['id']}/files"

    preview = client.get(url, params={"path": "SKILL.md"})
    assert preview.status_code == 200, preview.text
    body = preview.json()
    assert body["path"] == "SKILL.md"
    assert body["binary"] is False
    assert body["truncated"] is False
    assert "Review carefully." in body["content"]

    assert client.get(url, params={"path": "MISSING.md"}).status_code == 404
    assert client.get(url, params={"path": "SKILL.md", "channel": "nope"}).status_code == 422

    # An public skill previews for a colleague; a private one never does.
    login(client, "bob")
    assert client.get(url, params={"path": "SKILL.md"}).status_code == 200
    login(client, "alice")
    private = publish(client, name="sealed")
    login(client, "bob")
    response = client.get(
        f"/api/v1/skills/{private['id']}/files", params={"path": "SKILL.md"}
    )
    assert response.status_code == 404


def test_preview_reports_binary_and_truncated_bundle_files(client):
    skill = publish(client, name="mixed")
    long_text = "x" * (200 * 1024)
    revised = client.post(
        f"/api/v1/skills/{skill['id']}/revisions",
        json={
            "files": [
                {
                    "path": "SKILL.md",
                    "contentBase64": base64.b64encode(
                        f"---\nname: mixed\ndescription: Mixed\n---\n{long_text}".encode()
                    ).decode(),
                },
                {
                    "path": "logo.png",
                    "contentBase64": base64.b64encode(b"\x89PNG\r\n\x1a\n\xff\xfe").decode(),
                },
            ]
        },
    )
    assert revised.status_code == 201, revised.text
    url = f"/api/v1/skills/{skill['id']}/files"

    text = client.get(url, params={"path": "SKILL.md", "channel": "latest"}).json()
    assert text["truncated"] is True
    assert len(text["content"]) == 128 * 1024
    assert text["bytes"] > len(text["content"])

    binary = client.get(url, params={"path": "logo.png", "channel": "latest"}).json()
    assert binary["binary"] is True
    assert binary["content"] == ""


@pytest.mark.parametrize("operation", ["create", "import", "repository", "reimport", "revision", "promote", "update"])
def test_skill_mutations_keep_database_io_off_event_loop(client, monkeypatch, operation):
    import asyncio

    from sqlalchemy import event

    def fetch(url, ref, subpath, *, allowed_hosts):
        return [{"path": "SKILL.md", "content": b"---\nname: imported\ndescription: Imported\n---\nBody"}]

    monkeypatch.setattr("relay.skills.git_import.fetch_skill_bundle", fetch)
    monkeypatch.setattr("relay.skills.git_import.fetch_skill_repository", lambda *a, **k: [{"subpath": "imported", "files": fetch(None, None, None, allowed_hosts=[])}])
    source = {"name": "imported", "description": "Imported", "url": "https://github.com/example/review", "ref": "main", "subpath": "imported"}
    if operation == "reimport":
        response = client.post("/api/v1/skills/import", json=source)
        assert response.status_code == 201
        skill = response.json()
    else:
        skill = publish(client)
    url = f"/api/v1/skills/{skill['id']}"
    engine = client.app.state.skill_store.engine
    checked = []

    def assert_worker_thread(*args):
        try:
            asyncio.get_running_loop()
        except RuntimeError:
            checked.append(True)
        else:
            raise AssertionError("skill mutation executed SQL on the event loop")

    event.listen(engine, "before_cursor_execute", assert_worker_thread)
    try:
        if operation == "create":
            response = client.post("/api/v1/skills", json=bundle(name="another"))
        elif operation == "import":
            response = client.post("/api/v1/skills/import", json=source)
        elif operation == "repository":
            response = client.post("/api/v1/skills/import", json={**source, "subpath": ""})
        elif operation == "reimport":
            response = client.post(f"{url}/import")
        elif operation == "revision":
            response = client.post(f"{url}/revisions", json={"files": bundle()["files"]})
        elif operation == "promote":
            response = client.post(f"{url}/revisions/{skill['currentRevisionId']}/promote", json={})
        else:
            response = client.patch(url, json={"displayName": "Updated"})
        assert response.status_code == (201 if operation in {"create", "import", "repository", "reimport", "revision"} else 200), response.text
        assert checked, "the mutation must actually exercise the database"
    finally:
        event.remove(engine, "before_cursor_execute", assert_worker_thread)


@pytest.mark.parametrize("visibility", ["private", "public"])
def test_visibility_covers_catalog_downloads_and_assignment(client, visibility):
    skill = publish(client, visibility=visibility)
    agent, _ = create_agent(client, owner="bob")
    login(client, "bob")
    url = f"/api/v1/skills/{skill['id']}"
    expected = 200 if visibility == "public" else 404
    for path in (url, f"{url}/files?path=SKILL.md", f"{url}/export"):
        assert client.get(path).status_code == expected
    assert bool(client.get("/api/v1/skills").json()["skills"]) == (visibility == "public")
    assert client.post(f"{url}/grants", json={"agentIds": [agent["id"]]}).status_code == expected
    assert client.post(f"{url}/assignments", json={
        "targetType": "user", "targetId": BOB,
    }).status_code == (201 if visibility == "public" else 404)
    if visibility == "public":
        ctx = client.app.state.context
        assert resolve_bundle(ctx, ctx.agent_store.get_agent(agent["id"]))[0]["skills"]
        login(client, "alice")
        assert client.patch(url, json={"visibility": "private"}).status_code == 200
        login(client, "bob")
        assert client.get(url).status_code == 404
        assert resolve_bundle(ctx, ctx.agent_store.get_agent(agent["id"]))[0]["skills"] == []


def test_admin_cannot_read_another_users_private_skill(client):
    skill = publish(client)
    client.post("/api/v1/auth/logout")
    client.post("/api/v1/auth/login", json={"username": "admin", "password": "kestrel-vault-7719"})
    assert client.get(f"/api/v1/skills/{skill['id']}").status_code == 404
    assert client.get("/api/v1/skills").json()["skills"] == []
