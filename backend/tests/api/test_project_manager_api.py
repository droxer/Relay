"""Relay's manager reads live project records and stages owner-applied changes."""
from fastapi.testclient import TestClient
import test_project_setup_api as setup_api
from test_project_setup_api import _take_command, _complete

setup_env = setup_api.setup_env


def _ready(app, node):
    app.state.registry.register({
        "sandboxId": node["id"], "userId": node["userId"],
        "token": f"token_{node['id']}", "protocolVersion": 1,
        "supportedAgents": ["codex", "claude"],
        "capabilities": ["thread-workspaces", "project-workspaces", "project-manager"],
        "status": "ready", "workspacePath": "/workspace/relay",
        "workspaceId": node["workspaceId"],
    })


def _start(env):
    app, client, node, project, *_ = env
    _ready(app, node)
    response = client.post(f"/api/v1/projects/{project['id']}/manager/messages", json={
        "text": "What should we do next?", "idempotencyKey": "manager-first",
    })
    assert response.status_code == 202, response.text
    return response.json(), _take_command(app, node)


def _tool(env, command, tool, arguments=None):
    app, _, node, *_ = env
    return TestClient(app).post(
        f"/api/v1/daemon-nodes/{node['id']}/project-manager/tools",
        headers={"Authorization": f"Bearer token_{node['id']}"},
        json={"commandId": command["id"], "leaseId": command["leaseId"],
              "tool": tool, "arguments": arguments or {}},
    )


def test_manager_read_selects_stable_default_without_a_run(setup_env):
    app, client, _, project, planner, _ = setup_env
    url = f"/api/v1/projects/{project['id']}/manager"
    response = client.get(url)
    assert response.status_code == 200
    assert response.json()["manager"]["agentId"] == planner["id"]
    assert response.json()["manager"]["threadId"] is None
    assert not app.state.session_store.list_sessions()
    assert not client.get(url).json()["manager"]["toolsAvailable"]


def test_manager_round_is_single_agent_thread_scoped_and_reuses_thread(setup_env):
    app, client, node, project, planner, _ = setup_env
    result, command = _start(setup_env)
    assert command["state"]["project_manager"]["projectId"] == project["id"]
    assert command["agentId"] == planner["id"]
    assert not command.get("taskId")
    _complete(app, node, command, result["threadId"])
    second = client.post(f"/api/v1/projects/{project['id']}/manager/messages", json={
        "text": "And now?", "idempotencyKey": "manager-second",
    })
    assert second.status_code == 202, second.text
    assert second.json()["threadId"] == result["threadId"]


def test_live_tools_proposals_apply_once_in_backlog(setup_env):
    app, client, node, project, _, builder = setup_env
    result, command = _start(setup_env)
    url = f"/api/v1/projects/{project['id']}/manager"
    task = client.post("/api/v1/tasks", json={"title": "Old title", "projectId": project["id"]}).json()
    read = _tool(setup_env, command, "tasks")
    assert read.status_code == 200, read.text
    assert read.json()["tasks"][0]["title"] == "Old title"
    staged = _tool(setup_env, command, "propose", {"operations": [
        {"kind": "update", "taskId": task["id"], "fields": {"title": "New title", "priority": "high"}},
        {"kind": "create", "key": "build", "fields": {"title": "Build", "assignedAgentId": builder["id"]}, "afterTaskIds": [task["id"]]},
    ]})
    assert staged.status_code == 200, staged.text
    proposal = staged.json()["proposal"]
    assert client.get(f"/api/v1/tasks/{task['id']}").json()["title"] == "Old title"
    _complete(app, node, command, result["threadId"])
    applied = client.post(f"{url}/proposals/{proposal['id']}/apply", json={"idempotencyKey": "apply-one"})
    assert applied.status_code == 200, applied.text
    created = applied.json()["tasks"][1]
    assert created["status"] == "backlog"
    assert created["prerequisiteTaskIds"] == [task["id"]]
    assert created["assignedAgentId"] == builder["id"]
    assert client.get(f"/api/v1/tasks/{task['id']}").json()["title"] == "New title"
    again = client.post(f"{url}/proposals/{proposal['id']}/apply", json={"idempotencyKey": "apply-one"})
    assert again.status_code == 200
    assert again.json() == applied.json()
    assert _tool(setup_env, command, "overview").status_code == 409


def test_stale_proposal_rolls_back_and_scope_cannot_be_forged(setup_env):
    app, client, _, project, *_ = setup_env
    _, command = _start(setup_env)
    task = client.post("/api/v1/tasks", json={"title": "One", "projectId": project["id"]}).json()
    staged = _tool(setup_env, command, "propose", {"operations": [
        {"kind": "create", "fields": {"title": "Must roll back"}},
        {"kind": "update", "taskId": task["id"], "fields": {"priority": "high"}},
    ]})
    assert staged.status_code == 200, staged.text
    client.patch(f"/api/v1/tasks/{task['id']}", json={"title": "Changed elsewhere"})
    response = client.post(f"/api/v1/projects/{project['id']}/manager/proposals/{staged.json()['proposal']['id']}/apply", json={"idempotencyKey": "stale"})
    assert response.status_code == 409
    assert all(t["title"] != "Must roll back" for t in client.get("/api/v1/tasks").json()["tasks"])
    assert _tool(setup_env, command, "task", {"taskId": "foreign"}).status_code == 404
    assert _tool(setup_env, command, "apply", {}).status_code == 400
    client.cookies.clear()
    assert client.get(f"/api/v1/projects/{project['id']}/manager").status_code == 401
