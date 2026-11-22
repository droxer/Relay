"""Project Workflow creation through the hosted MCP protocol."""

from fastapi.testclient import TestClient

import test_project_manager_api as manager_api
from test_relay_mcp_api import _token
from test_relay_mcp_protocol import _rpc
from test_relay_mcp_work import credential

managed_env = manager_api.managed_env
setup_env = manager_api.setup_env
TOOL = "relay_create_workflow"


def _step(step_id, agent):
    return {
        "id": step_id,
        "name": step_id.title(),
        "agentId": agent["id"],
        "instructions": f"{step_id.title()} the change.",
        "acceptanceCriteria": ["Record the result."],
    }


def _tools(client, token):
    return {tool["name"] for tool in _rpc(client, token, "tools/list").json()["result"]["tools"]}


def _result(client, token, arguments):
    response = _rpc(client, token, "tools/call", {"name": TOOL, "arguments": arguments})
    assert response.status_code == 200, response.text
    return response.json()["result"]


def _denied(client, token, **arguments):
    result = _result(client, token, arguments)
    assert result["isError"], result
    return result["content"][0]["text"]


def test_project_lead_can_create_a_reusable_workflow(managed_env):
    app, owner, node, project, lead, builder = managed_env
    manager_api._join(managed_env, builder)
    _, command = manager_api._start(managed_env)
    token = credential(app, node, command)
    steps = [_step("build", builder), {**_step("review", lead), "requiresApproval": True}]
    inputs = {"projectId": project["id"], "name": "Build and review", "workflowSteps": steps, "enabled": False}
    with TestClient(app) as client:
        assert TOOL in _tools(client, token)
        result = _result(client, token, inputs)
        assert not result.get("isError"), result
        workflow = result["structuredContent"]["workflow"]
        assert workflow["name"] == inputs["name"]
        assert workflow["projectId"] == project["id"]
        assert workflow["ownerUserId"] == project["ownerUserId"]
        assert workflow["enabled"] is False
        assert workflow["version"] == 1
        assert workflow["workflowSteps"] == [{**steps[0], "requiresApproval": False}, steps[1]]
        assert "workflow_name_taken" in _denied(client, token, **{**inputs, "name": "build and review"})

    saved = owner.get(f"/api/v1/workflows/{workflow['id']}")
    assert saved.status_code == 200, saved.text
    assert saved.json()["workflow"] == workflow
    assert len(app.state.session_store.list_sessions()) == 1  # The Lead's Thread is the only run.


def test_creation_checks_project_scope_step_membership_and_live_lead(managed_env):
    app, owner, node, project, lead, builder = managed_env
    _, command = manager_api._start(managed_env)
    token = credential(app, node, command)
    response = owner.post("/api/v1/projects", json={"name": "Other Project", "daemonNodeId": node["id"], "members": []})
    assert response.status_code == 201, response.text
    other = response.json()["project"]
    inputs = {"projectId": project["id"], "name": "Scoped Workflow", "workflowSteps": [_step("review", lead)]}
    with TestClient(app) as client:
        assert "does not grant access" in _denied(client, token, **{**inputs, "projectId": other["id"]})
        assert "team_workflow_project_not_member" in _denied(client, token, **{**inputs, "workflowSteps": [_step("build", builder)]})
        assert _denied(client, token, **inputs, ownerTeamId="unexpected")
        legacy = client.post(f"/api/v1/mcp/projects/{project['id']}/tools",
                             headers={"Authorization": f"Bearer {token}"},
                             json={"tool": "create_workflow", "arguments": {**inputs, "ownerTeamId": "unexpected"}})
        assert legacy.status_code == 400, legacy.text
        manager_api._join(managed_env, builder)
        manager_api._assign(owner, project, builder)
        assert "project_manager_required" in _denied(client, token, **inputs)

    assert owner.get("/api/v1/workflows").json()["workflows"] == []


def test_workflow_tool_is_unavailable_to_project_readers_and_local_tokens(managed_env):
    app, owner, node, project, _, builder = managed_env
    manager_api._join(managed_env, builder)
    command = manager_api._run_task(managed_env, {"title": "Reader", "assignedAgentId": builder["id"]})
    tokens = [credential(app, node, command), credential(app, node), _token(owner, project)["token"]]
    with TestClient(app) as client:
        for token in tokens:
            assert TOOL not in _tools(client, token)
            assert _denied(client, token, projectId=project["id"], name="Forbidden", workflowSteps=[_step("build", builder)])

    assert owner.get("/api/v1/workflows").json()["workflows"] == []
