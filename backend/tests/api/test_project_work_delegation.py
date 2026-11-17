import asyncio

import pytest

import test_project_execution_policy as project_api
from test_project_routes import _agent, _login_alice


@pytest.fixture
def project_context(monkeypatch, tmp_path):
    return project_api.project_context.__wrapped__(monkeypatch, tmp_path)


def start_work(env, entry):
    app, client, node, project, lead, worker = env
    app.state.registry.register({
        "sandboxId": node["id"], "userId": node["userId"], "token": f"token_{node['id']}",
        "protocolVersion": 1, "supportedAgents": ["codex", "claude"],
        "workspacePath": node["workspacePath"], "workspaceId": node["workspaceId"],
        "capabilities": [*node["capabilities"], "work-results", "round-result", "direct-delegation",
                         "relay-thread-records", "handoff-validation"],
    })
    created = client.post("/api/v1/tasks", json={
        "title": "Build", "projectId": project["id"], "assignedAgentId": lead["id"], "status": "assigned",
    })
    assert created.status_code == 201, created.text
    task = created.json()
    if entry == "scheduler":
        assert asyncio.run(app.state.task_scheduler.tick()).dispatched == 1
    else:
        response = client.post(f"/api/v1/tasks/{task['id']}/runs", json={})
        assert response.status_code == 202, response.text
    [command] = app.state.registry.take_commands(node["id"], f"token_{node['id']}")
    return task, command


def finish(app, node, command, work):
    event = {"type": "run.completed", "commandId": command["id"], "runId": command["runId"],
             "sessionId": command["sessionId"], "agent": command["agent"], "exitCode": 0,
             "roundResult": {"status": work["status"], "work": work}, "agentLog": "Returned work"}
    app.state.registry.handle_event(node["id"], event, f"token_{node['id']}")


def delegation(worker):
    return {"status": "continue", "delegation": {"agentId": worker["id"], "objective": "Write tests",
        "acceptanceCriteria": ["Tests pass"], "expectedOutputs": ["tests"]}}


@pytest.mark.parametrize("entry", ["manual", "scheduler"])
def test_project_work_delegates_and_returns_only_among_members(project_context, entry):
    app, client, node, project, lead, worker = project_context
    # Even another available Agent on this Computer cannot receive Project work.
    client.post("/api/v1/auth/login", json={"username": "admin", "password": "kestrel-vault-7719"})
    outsider = _agent(client, app, node, "Outside", "codex")
    _login_alice(client)
    task, first = start_work(project_context, entry)
    ids = {item["agentId"] for item in first["state"].get("delegation_candidates", [])}
    assert ids == {worker["id"]}
    assert outsider["id"] not in ids
    finish(app, node, first, delegation(worker))
    [child] = app.state.registry.take_commands(node["id"], f"token_{node['id']}")
    assert child["logicalAgentId"] == worker["id"]
    assert child["sessionId"] == first["sessionId"]
    finish(app, node, child, {"status": "done", "evidence": ["Tests pass"]})
    [resumed] = app.state.registry.take_commands(node["id"], f"token_{node['id']}")
    assert resumed["logicalAgentId"] == lead["id"]


def test_member_removed_before_delegate_proposal_is_refused(project_context):
    app, client, node, project, lead, worker = project_context
    _, first = start_work(project_context, "manual")
    assert worker["id"] in {item["agentId"] for item in first["state"].get("delegation_candidates", [])}
    response = client.patch(f"/api/v1/projects/{project['id']}", json={
        "expectedVersion": project["version"],
        "members": [member for member in project["members"] if member["agentId"] != worker["id"]],
    })
    assert response.status_code == 200, response.text
    finish(app, node, first, delegation(worker))
    [resumed] = app.state.registry.take_commands(node["id"], f"token_{node['id']}")
    assert resumed["logicalAgentId"] == lead["id"]
    assert "refused" in resumed["state"]["delegation_return"].lower()


@pytest.mark.parametrize("target", ["member", "outsider"])
def test_project_task_handoff_keeps_task_scope_and_member_boundary(project_context, target):
    app, client, node, project, lead, worker = project_context
    client.post("/api/v1/auth/login", json={"username": "admin", "password": "kestrel-vault-7719"})
    outsider = _agent(client, app, node, "Outside", "codex")
    _login_alice(client)
    task, first = start_work(project_context, "manual")
    finish(app, node, first, {"status": "blocked", "note": "Need help", "evidence": []})
    response = client.post(f"/api/v1/threads/{first['sessionId']}/recoveries", json={
        "kind": "handoff", "targetAgentId": (worker if target == "member" else outsider)["id"],
    })
    if target == "outsider":
        assert response.status_code == 400, response.text
        assert response.json()["detail"] == "project_agent_not_member"
    else:
        assert response.status_code == 202, response.text
        [command] = app.state.registry.take_commands(node["id"], f"token_{node['id']}")
        assert command["logicalAgentId"] == worker["id"]
        assert command["sessionId"] == first["sessionId"]
