from __future__ import annotations

import base64
from tempfile import TemporaryDirectory

from fastapi.testclient import TestClient
from relay.app import create_app
from relay.core.computer_identity import computer_id

PNG_BYTES = b"\x89PNG\r\n\x1a\nrelay-profile"
PNG_DATA_URL = "data:image/png;base64," + base64.b64encode(PNG_BYTES).decode("ascii")


def bootstrap(client: TestClient) -> None:
    assert (
        client.post(
            "/api/v1/auth/bootstrap",
            json={"token": "admin_token", "username": "admin", "password": "kestrel-vault-7719"},
        ).status_code
        == 200
    )


def employee(client: TestClient, employee_id: str) -> None:
    assert (
        client.post(
            "/api/v1/admin/employees",
            json={
                "employeeId": employee_id,
                "username": employee_id,
                "password": "userpass",
                "displayName": employee_id.title(),
            },
        ).status_code
        == 201
    )


def _agent(client: TestClient, employee_id: str) -> dict:
    # An offline birth-certificate computer: enough to mint a computerId
    # without auto-placing the agent, so callers that manually place it
    # afterward don't hit a duplicate-placement conflict.
    node = client.app.state.registry.register(
        {
            "sandboxId": f"test_node_{employee_id}",
            "employeeId": employee_id,
            "workspaceId": f"machine-{employee_id}",
            "token": "node_token",
            "workspacePath": f"/workspace/{employee_id}",
            "protocolVersion": 1,
            "supportedAgents": ["codex"],
            "capabilities": ["thread-workspaces"],
            "status": "stopped",
        }
    )
    response = client.post(
        "/api/v1/admin/agents",
        json={
            "supervisorEmployeeId": employee_id,
            "displayName": "Builder",
            "executorKind": "codex",
            "defaultRole": "implementer",
            "computerId": computer_id(node),
        },
    )
    assert response.status_code == 201, response.text
    return response.json()["agent"]


def test_employee_updates_and_removes_agent_and_team_profile_images(
    monkeypatch,
) -> None:
    monkeypatch.setenv("RELAY_ADMIN_TOKEN", "admin_token")
    with TemporaryDirectory() as root:
        client = TestClient(create_app(root))
        bootstrap(client)
        employee(client, "alice")
        agent = _agent(client, "alice")
        client.app.state.agent_placement_store.create_placement(
            agent, "test_node_alice"
        )
        team = client.post(
            "/api/v1/admin/teams",
            json={
                "ownerEmployeeId": "alice",
                "name": "Delivery",
                "leadAgentId": agent["id"],
                "memberAgentIds": [agent["id"]],
            },
        ).json()["team"]
        assert client.post("/api/v1/auth/logout").status_code == 200
        assert (
            client.post(
                "/api/v1/auth/login", json={"username": "alice", "password": "userpass"}
            ).status_code
            == 200
        )

        agent_update = client.put(
            f"/profile-images/agents/{agent['id']}", json={"dataUrl": PNG_DATA_URL}
        )
        team_update = client.put(
            f"/profile-images/teams/{team['id']}", json={"dataUrl": PNG_DATA_URL}
        )

        assert agent_update.status_code == 200
        assert team_update.status_code == 200
        agent_url = agent_update.json()["agent"]["profileImageUrl"]
        team_url = team_update.json()["team"]["profileImageUrl"]
        assert agent_url.startswith(f"/profile-images/agents/{agent['id']}?v=")
        assert team_url.startswith(f"/profile-images/teams/{team['id']}?v=")
        assert client.get(agent_url).content == PNG_BYTES
        assert client.get(team_url).headers["content-type"] == "image/png"
        assert (
            client.get("/api/v1/agents").json()["agents"][0]["profileImageUrl"]
            == agent_url
        )
        assert (
            client.get("/api/v1/teams").json()["teams"][0]["profileImageUrl"]
            == team_url
        )

        removed = client.delete(f"/profile-images/agents/{agent['id']}")
        assert removed.status_code == 200
        assert removed.json()["agent"]["profileImageUrl"] is None
        assert client.get(agent_url).status_code == 404


def test_employee_cannot_update_another_employees_profile_image(monkeypatch) -> None:
    monkeypatch.setenv("RELAY_ADMIN_TOKEN", "admin_token")
    with TemporaryDirectory() as root:
        client = TestClient(create_app(root))
        bootstrap(client)
        employee(client, "alice")
        employee(client, "bob")
        agent = _agent(client, "bob")
        assert client.post("/api/v1/auth/logout").status_code == 200
        assert (
            client.post(
                "/api/v1/auth/login", json={"username": "alice", "password": "userpass"}
            ).status_code
            == 200
        )

        response = client.put(
            f"/profile-images/agents/{agent['id']}", json={"dataUrl": PNG_DATA_URL}
        )

        assert response.status_code == 403


def test_profile_image_endpoint_rejects_unsupported_data(monkeypatch) -> None:
    monkeypatch.setenv("RELAY_ADMIN_TOKEN", "admin_token")
    with TemporaryDirectory() as root:
        client = TestClient(create_app(root))
        bootstrap(client)
        employee(client, "alice")
        agent = _agent(client, "alice")

        response = client.put(
            f"/profile-images/agents/{agent['id']}",
            json={"dataUrl": "data:image/gif;base64,R0lGODlhAQABAIAAAAUEBA=="},
        )

        assert response.status_code == 400
        assert response.json()["detail"] == "profile_image_type"


def _login_as(client: TestClient, username: str) -> None:
    assert client.post("/api/v1/auth/logout").status_code == 200
    assert (
        client.post(
            "/api/v1/auth/login", json={"username": username, "password": "userpass"}
        ).status_code
        == 200
    )


def _admin_team(client: TestClient, agent: dict, **extra) -> dict:
    response = client.post(
        "/api/v1/admin/teams",
        json={
            "ownerEmployeeId": agent["supervisorEmployeeId"],
            "name": "Delivery",
            "leadAgentId": agent["id"],
            "memberAgentIds": [agent["id"]],
            **extra,
        },
    )
    assert response.status_code == 201, response.text
    return response.json()["team"]


def test_choosing_a_preset_replaces_and_deletes_an_uploaded_image(monkeypatch) -> None:
    monkeypatch.setenv("RELAY_ADMIN_TOKEN", "admin_token")
    with TemporaryDirectory() as root:
        client = TestClient(create_app(root))
        bootstrap(client)
        employee(client, "alice")
        agent = _agent(client, "alice")
        team = _admin_team(client, agent)
        _login_as(client, "alice")
        uploaded = client.put(
            f"/profile-images/agents/{agent['id']}", json={"dataUrl": PNG_DATA_URL}
        ).json()["agent"]["profileImageUrl"]

        agent_preset = client.put(
            f"/profile-images/agents/{agent['id']}",
            json={"presetUrl": "/avatars/agents/bottts-07.svg"},
        )
        team_preset = client.put(
            f"/profile-images/teams/{team['id']}",
            json={"presetUrl": "/avatars/teams/shape-grid-03.svg"},
        )

        assert agent_preset.status_code == 200, agent_preset.text
        assert agent_preset.json()["agent"]["profileImageUrl"] == "/avatars/agents/bottts-07.svg"
        assert team_preset.status_code == 200, team_preset.text
        assert team_preset.json()["team"]["profileImageUrl"] == "/avatars/teams/shape-grid-03.svg"
        assert client.get(uploaded).status_code == 404


def test_preset_endpoint_rejects_unknown_and_wrong_kind_presets(monkeypatch) -> None:
    monkeypatch.setenv("RELAY_ADMIN_TOKEN", "admin_token")
    with TemporaryDirectory() as root:
        client = TestClient(create_app(root))
        bootstrap(client)
        employee(client, "alice")
        agent = _agent(client, "alice")

        for preset in (
            "/avatars/teams/shape-grid-01.svg",
            "/avatars/agents/bottts-99.svg",
            "/avatars/agents/../../secret.svg",
        ):
            response = client.put(
                f"/profile-images/agents/{agent['id']}", json={"presetUrl": preset}
            )
            assert response.status_code == 400, preset
            assert response.json()["detail"] == "profile_image_preset"
        assert client.get("/api/v1/admin/agents").json()["agents"][0].get("profileImageUrl") is None


def test_agents_and_teams_can_be_created_with_a_preset(monkeypatch) -> None:
    monkeypatch.setenv("RELAY_ADMIN_TOKEN", "admin_token")
    with TemporaryDirectory() as root:
        client = TestClient(create_app(root))
        bootstrap(client)
        employee(client, "alice")
        node = client.app.state.registry.register(
            {
                "sandboxId": "test_node_alice",
                "employeeId": "alice",
                "workspaceId": "machine-alice",
                "token": "node_token",
                "workspacePath": "/workspace/alice",
                "protocolVersion": 1,
                "supportedAgents": ["codex"],
                "capabilities": ["thread-workspaces"],
                "status": "stopped",
            }
        )
        _login_as(client, "alice")

        created = client.post(
            "/api/v1/agents",
            json={
                "displayName": "Builder",
                "executorKind": "codex",
                "defaultRole": "implementer",
                "computerId": computer_id(node),
                "profileImageUrl": "/avatars/agents/bottts-02.svg",
            },
        )
        assert created.status_code == 201, created.text
        agent = created.json()["agent"]
        assert agent["profileImageUrl"] == "/avatars/agents/bottts-02.svg"

        team = client.post(
            "/api/v1/teams",
            json={
                "name": "Delivery",
                "leadAgentId": agent["id"],
                "memberAgentIds": [agent["id"]],
                "profileImageUrl": "/avatars/teams/shape-grid-12.svg",
            },
        )
        assert team.status_code == 201, team.text
        assert team.json()["team"]["profileImageUrl"] == "/avatars/teams/shape-grid-12.svg"

        rejected = client.post(
            "/api/v1/teams",
            json={
                "name": "Other",
                "leadAgentId": agent["id"],
                "memberAgentIds": [agent["id"]],
                "profileImageUrl": "/profile-images/teams/whatever?v=1",
            },
        )
        assert rejected.status_code == 400


def test_admin_creates_agent_and_team_with_a_preset(monkeypatch) -> None:
    monkeypatch.setenv("RELAY_ADMIN_TOKEN", "admin_token")
    with TemporaryDirectory() as root:
        client = TestClient(create_app(root))
        bootstrap(client)
        employee(client, "alice")
        node = client.app.state.registry.register(
            {
                "sandboxId": "test_node_alice",
                "employeeId": "alice",
                "workspaceId": "machine-alice",
                "token": "node_token",
                "workspacePath": "/workspace/alice",
                "protocolVersion": 1,
                "supportedAgents": ["codex"],
                "capabilities": ["thread-workspaces"],
                "status": "stopped",
            }
        )
        created = client.post(
            "/api/v1/admin/agents",
            json={
                "supervisorEmployeeId": "alice",
                "executorKind": "codex",
                "defaultRole": "implementer",
                "computerId": computer_id(node),
                "profileImageUrl": "/avatars/agents/bottts-16.svg",
            },
        )
        assert created.status_code == 201, created.text
        agent = created.json()["agent"]
        assert agent["profileImageUrl"] == "/avatars/agents/bottts-16.svg"

        team = _admin_team(client, agent, profileImageUrl="/avatars/teams/shape-grid-01.svg")
        assert team["profileImageUrl"] == "/avatars/teams/shape-grid-01.svg"
