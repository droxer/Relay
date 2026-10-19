"""A project may link an existing directory on its computer, validated there."""

from __future__ import annotations

from tempfile import TemporaryDirectory
from typing import Any

import pytest
from fastapi.testclient import TestClient
from relay.api.projects import links as project_links
from relay.app import create_app

from test_project_routes import _bootstrap, _login_alice
from user_ids import user_id

ALICE = user_id("alice")

LINK_CAPABILITIES = ["thread-workspaces", "project-workspaces", "project-links"]


def _register(app, node_id: str, *, capabilities: list[str] = LINK_CAPABILITIES) -> dict:
    return app.state.registry.register(
        {
            "sandboxId": node_id,
            "userId": ALICE,
            "token": f"token_{node_id}",
            "protocolVersion": 1,
            "supportedAgents": ["codex", "claude"],
            "capabilities": [*capabilities, "project-workspace-delete"],
            "status": "ready",
            "workspacePath": "/workspace/relay",
            "workspaceId": f"machine-{node_id}",
        }
    )


@pytest.fixture
def env(monkeypatch):
    monkeypatch.setenv("RELAY_ADMIN_TOKEN", "admin_token")
    with TemporaryDirectory() as root:
        app = create_app(root)
        client = TestClient(app)
        _bootstrap(client)
        node = _register(app, "node_links")
        _login_alice(client)
        yield app, client, node


@pytest.fixture
def daemon(monkeypatch):
    """Stands in for the computer: records each command and answers it."""
    sent: list[dict[str, Any]] = []
    answer: dict[str, Any] = {}

    async def dispatch(ctx, node, command):
        sent.append({"nodeId": node["id"], **command})
        if answer:
            return {"type": "workspace.error", "commandId": command["id"], "path": "", **answer}
        return {
            "type": "workspace.linked",
            "commandId": command["id"],
            "path": "",
            "hostPath": command["hostPath"].rstrip("/"),
        }

    monkeypatch.setattr(project_links, "dispatch_workspace_command", dispatch)
    return sent, answer


def _create(client: TestClient, node: dict, **fields: Any):
    return client.post(
        "/api/v1/projects",
        json={"name": "Existing repo", "daemonNodeId": node["id"], "members": [], "leadAgentId": None, **fields},
    )


def test_project_links_an_existing_directory_on_its_computer(env, daemon) -> None:
    app, client, node = env
    sent, _ = daemon

    response = _create(client, node, workspaceHostPath="/Users/alice/code/app/")

    assert response.status_code == 201, response.text
    project = response.json()["project"]
    [command] = sent
    assert command["type"] == "workspace.link"
    assert command["nodeId"] == node["id"]
    assert command["hostPath"] == "/Users/alice/code/app/"
    assert "dryRun" not in command
    assert project["workspaceSubpath"] == command["workspaceSubpath"]
    assert project["workspaceSubpath"].startswith("links/")
    assert project["workspaceHostPath"] == "/Users/alice/code/app"
    assert app.state.project_store.list_linked_workspaces(project["computerId"]) == [
        {"workspaceSubpath": project["workspaceSubpath"], "hostPath": "/Users/alice/code/app"}
    ]


def test_project_without_a_path_keeps_its_canonical_workspace(env, daemon) -> None:
    app, client, node = env
    sent, _ = daemon

    response = _create(client, node, workspaceHostPath="  ")

    assert response.status_code == 201, response.text
    project = response.json()["project"]
    assert sent == []
    assert project["workspaceSubpath"] == f"projects/{project['id']}"
    assert "workspaceHostPath" not in project


def test_refused_directory_creates_no_project(env, daemon) -> None:
    app, client, node = env
    _, answer = daemon
    answer.update(code="not-allowed", message="/etc is outside the directories this computer allows: /Users/alice.")

    response = _create(client, node, workspaceHostPath="/etc")

    assert response.status_code == 422
    assert response.json()["detail"] == {
        "code": "project_workspace_not_allowed",
        "message": "/etc is outside the directories this computer allows: /Users/alice.",
    }
    assert app.state.project_store.list_projects(ALICE) == []


@pytest.mark.parametrize("path", ["code/app", "~/code", 7, "/a\x00b", "/" + "a" * 5000])
def test_project_path_must_be_absolute_text(env, daemon, path) -> None:
    app, client, node = env
    sent, _ = daemon

    response = _create(client, node, workspaceHostPath=path)

    assert response.status_code == 400
    assert response.json()["detail"] == "project_workspace_path_invalid"
    assert sent == []


def test_older_daemon_cannot_link(env, daemon) -> None:
    app, client, _ = env
    sent, _ = daemon
    older = _register(app, "node_older", capabilities=["thread-workspaces", "project-workspaces"])

    response = _create(client, older, workspaceHostPath="/Users/alice/code/app")

    assert response.status_code == 409
    assert response.json()["detail"] == "project_workspace_link_unsupported"
    assert sent == []


def test_workspace_check_is_a_dry_run(env, daemon) -> None:
    app, client, node = env
    sent, _ = daemon

    response = client.post(
        "/api/v1/projects/workspace-check",
        json={"daemonNodeId": node["id"], "workspaceHostPath": "/Users/alice/code/app"},
    )

    assert response.status_code == 200, response.text
    assert response.json() == {"workspaceHostPath": "/Users/alice/code/app"}
    [command] = sent
    assert command["dryRun"] is True
    assert app.state.project_store.list_projects(ALICE) == []


def test_workspace_check_refuses_another_users_computer(env, daemon) -> None:
    app, client, node = env
    sent, _ = daemon
    app.state.registry.register(
        {
            "sandboxId": "node_bob",
            "userId": user_id("bob"),
            "token": "token_node_bob",
            "protocolVersion": 1,
            "supportedAgents": ["codex"],
            "capabilities": LINK_CAPABILITIES,
            "status": "ready",
            "workspacePath": "/workspace/bob",
            "workspaceId": "machine-bob",
        }
    )

    response = client.post(
        "/api/v1/projects/workspace-check",
        json={"daemonNodeId": "node_bob", "workspaceHostPath": "/Users/bob"},
    )

    assert response.status_code == 400
    assert response.json()["detail"] == "project_computer_forbidden"
    assert sent == []


def test_registration_returns_the_computers_links(env, daemon) -> None:
    app, client, node = env
    linked = _create(client, node, workspaceHostPath="/Users/alice/code/app").json()["project"]
    _create(client, node, name="Plain project")

    response = client.post(
        "/api/v1/daemon-node-registrations",
        headers={"Authorization": f"Bearer token_{node['id']}"},
        json={
            "sandboxId": node["id"],
            "userId": ALICE,
            "protocolVersion": 1,
            "supportedAgents": ["codex", "claude"],
            "capabilities": LINK_CAPABILITIES,
            "status": "ready",
            "workspacePath": "/workspace/relay",
            "workspaceId": f"machine-{node['id']}",
        },
    )

    assert response.status_code == 200, response.text
    assert response.json()["projectLinks"] == [
        {"workspaceSubpath": linked["workspaceSubpath"], "hostPath": "/Users/alice/code/app"}
    ]


def test_link_command_response_is_recorded(env) -> None:
    app, client, node = env
    app.state.registry.enqueue(
        node["id"],
        {"id": "cmd-link", "type": "workspace.link", "workspaceSubpath": "links/x", "hostPath": "/Users/alice/app"},
    )
    [command] = app.state.registry.take_commands(node["id"], f"token_{node['id']}")

    response = client.post(
        f"/api/v1/daemon-nodes/{node['id']}/events",
        headers={"Authorization": f"Bearer token_{node['id']}"},
        json={"type": "workspace.linked", "commandId": "cmd-link", "leaseId": command["leaseId"], "path": "", "hostPath": "/Users/alice/app"},
    )

    assert response.status_code == 200, response.text
    assert app.state.daemon_store.get_workspace_response("cmd-link")["hostPath"] == "/Users/alice/app"


def test_link_refusal_codes_are_accepted(env) -> None:
    app, client, node = env
    app.state.registry.enqueue(
        node["id"],
        {"id": "cmd-refuse", "type": "workspace.link", "workspaceSubpath": "links/y", "hostPath": "/"},
    )
    [command] = app.state.registry.take_commands(node["id"], f"token_{node['id']}")

    response = client.post(
        f"/api/v1/daemon-nodes/{node['id']}/events",
        headers={"Authorization": f"Bearer token_{node['id']}"},
        json={"type": "workspace.error", "commandId": "cmd-refuse", "leaseId": command["leaseId"], "path": "", "code": "protected", "message": "A filesystem root cannot be a project directory."},
    )

    assert response.status_code == 200, response.text
    assert app.state.daemon_store.get_workspace_response("cmd-refuse")["code"] == "protected"


def test_deleting_a_linked_project_keeps_the_directory(env, daemon) -> None:
    app, client, node = env
    project = _create(client, node, workspaceHostPath="/Users/alice/code/app").json()["project"]

    response = client.delete(f"/api/v1/projects/{project['id']}?expectedVersion=1")

    assert response.status_code == 200, response.text
    assert response.json()["workspaceCleanup"] == "kept"
    assert response.json()["cleanupCommandId"] is None
    assert app.state.project_store.get_project(project["id"]) is None
    assert app.state.registry.take_commands(node["id"], f"token_{node['id']}") == []
    assert app.state.project_store.list_linked_workspaces(project["computerId"]) == []


def test_sibling_daemon_learns_the_link_and_an_overloaded_one_is_tolerated(env, daemon, monkeypatch) -> None:
    app, client, node = env
    live = project_links._live_link_nodes
    sibling = {**node, "id": "node_sibling"}
    monkeypatch.setattr(project_links, "_live_link_nodes", lambda nodes, target: [*live(nodes, target), sibling])
    queued: list[tuple[str, dict]] = []
    monkeypatch.setattr(app.state.registry, "enqueue", lambda node_id, command: queued.append((node_id, command)))

    created = _create(client, node, workspaceHostPath="/Users/alice/code/app")

    assert created.status_code == 201, created.text
    project = created.json()["project"]
    [(node_id, command)] = queued
    assert node_id == "node_sibling"
    assert command["type"] == "workspace.link"
    assert command["workspaceSubpath"] == project["workspaceSubpath"]
    assert command["hostPath"] == "/Users/alice/code/app"

    def overloaded(*args, **kwargs):
        raise ValueError("queue full")

    monkeypatch.setattr(app.state.registry, "enqueue", overloaded)
    response = _create(client, node, name="Second", workspaceHostPath="/Users/alice/code/other")
    assert response.status_code == 201, response.text


def test_linked_project_artifacts_name_the_real_directory(env, daemon) -> None:
    app, client, node = env
    project = _create(client, node, workspaceHostPath="/Users/alice/code/app").json()["project"]
    session = {"projectId": project["id"], "workspaceSubpath": project["workspaceSubpath"]}

    assert app.state.registry._linked_workspace_path(session) == "/Users/alice/code/app"
    assert app.state.registry._linked_workspace_path({**session, "workspaceSubpath": "links/other"}) is None


def test_linked_workspace_browsing_requires_a_link_capable_daemon():
    from fastapi import HTTPException
    from relay.api.computers.workspace_transport import workspace_binding_target

    binding = {"computerId": "node:one", "layout": "project", "subpath": "links/repo"}
    older = {"id": "one", "online": True, "capabilities": ["project-workspaces", "workspace-read-shared"]}
    with pytest.raises(HTTPException) as raised:
        workspace_binding_target([older], binding)
    assert raised.value.detail["reason"] == "workspace-unsupported"
    capable = {**older, "capabilities": [*older["capabilities"], "project-links"]}
    assert workspace_binding_target([older, capable], binding) == (capable, "project", "links/repo")


@pytest.mark.parametrize("command_type", ["workspace.list", "workspace.read", "workspace.link"])
def test_linked_workspace_commands_are_not_delivered_after_a_downgrade(env, command_type):
    app, _, node = env
    command = {
        "id": "cmd-downgrade", "type": command_type,
        "sessionId": "project", "workspaceLayout": "project", "workspaceSubpath": "links/repo",
        "hostPath": "/Users/alice/code/app", "path": "README.md",
    }
    app.state.registry.enqueue(node["id"], command)
    _register(app, node["id"], capabilities=["thread-workspaces", "project-workspaces"])
    assert app.state.registry.take_commands(node["id"], f"token_{node['id']}") == []
    response = app.state.daemon_store.get_workspace_response(command["id"])
    assert response["type"] == "workspace.error"
    assert "project-links" in response["message"]
