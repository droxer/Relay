from contextlib import contextmanager

import pytest
from fastapi.testclient import TestClient

from relay.core.computer_identity import computer_id
from relay.sessions.controller import SessionController

from issue_projects import project_for_agents
from test_team_computer import _world, _agent, _sync, _admin_id


@contextmanager
def workflow_world(monkeypatch):
    monkeypatch.setenv("RELAY_CHAT_TOKEN", "chat-test")
    with _world(monkeypatch) as (app, client, here, there):
        here = app.state.registry.register({
            **here, "sandboxId": here["id"], "token": "token_node_here", "protocolVersion": 1, "supportedAgents": ["codex", "claude"],
            "capabilities": [*here["capabilities"], "project-workspaces", "project-reader-mcp", "round-result", "workflow-results"],
        })
        lead = _agent(app, here, "Designer")
        builder = _agent(app, here, "Builder")
        _sync(app, here, there)
        project = project_for_agents(app.state.project_store, _admin_id(app), [lead, builder])
        payload = {
            "name": "Workflow", "leadAgentId": lead["id"],
            "memberAgentIds": [lead["id"], builder["id"]], "projectId": project["id"],
            "workflowSteps": [
                {"id": "design", "name": "Design", "agentId": lead["id"], "instructions": "Design it",
                 "expectedOutputs": ["Design"], "acceptanceCriteria": ["Reviewed"]},
                {"id": "deploy", "name": "Deploy", "requiresApproval": True, "agentId": lead["id"],
                 "instructions": "Deploy it", "expectedOutputs": ["URL"], "acceptanceCriteria": ["Healthy"]},
            ],
        }
        yield app, client, here, there, project, payload


@pytest.mark.parametrize("admin", [False, True])
def test_owner_round_trip_and_immutable_project(monkeypatch, admin):
    with workflow_world(monkeypatch) as (app, client, _, _, project, payload):
        prefix = "/api/v1/admin/teams" if admin else "/api/v1/teams"
        body = {**payload, **({"ownerUserId": _admin_id(app)} if admin else {})}
        response = client.post(prefix, json=body)
        assert response.status_code == 201, response.text
        team = response.json()["team"]
        assert team["projectId"] == project["id"]
        assert team["workflowSteps"][1]["requiresApproval"] is True
        response = client.patch(f"{prefix}/{team['id']}", json={"workflowSteps": list(reversed(team["workflowSteps"]))})
        assert response.status_code == 200, response.text
        before = app.state.team_store.get_team(team["id"])
        events = app.state.team_store.events(team["id"])
        for patch in ({"projectId": None}, {"projectId": "other"}, {"workflowSteps": None}, {"workflowSteps": []}):
            assert client.patch(f"{prefix}/{team['id']}", json=patch).status_code == 400
            assert app.state.team_store.get_team(team["id"]) == before
            assert app.state.team_store.events(team["id"]) == events
        assert client.delete(f"{prefix}/{team['id']}").status_code == 200


@pytest.mark.parametrize("invalid", ["nonmember", "disabled_member", "disabled_agent", "foreign_agent", "wrong_computer", "foreign_project", "archived_project", "disabled_project"])
def test_live_save_validation_rejects_without_write(monkeypatch, invalid):
    with workflow_world(monkeypatch) as (app, client, here, there, project, payload):
        agent_id = payload["leadAgentId"]
        if invalid in {"nonmember", "disabled_member"}:
            members = project["members"][1:] if invalid == "nonmember" else [
                {**member, "enabled": False} if member["agentId"] == agent_id else member
                for member in project["members"]
            ]
            app.state.project_store.update_project(project["id"], {"members": members}, expected_version=project["version"])
        elif invalid == "disabled_agent":
            app.state.agent_store.update_agent(agent_id, {"enabled": False})
        elif invalid in {"foreign_agent", "wrong_computer"}:
            outsider = app.state.agent_store.create_agent(
                "foreign" if invalid == "foreign_agent" else _admin_id(app),
                {"displayName": "Outsider", "executorKind": "codex", "defaultRole": "implementer",
                 "computerId": project["computerId"] if invalid == "foreign_agent" else computer_id(there)},
            )
            payload["memberAgentIds"].append(outsider["id"])
            if invalid == "wrong_computer":
                app.state.project_store.update_project(project["id"], {"members": [
                    *project["members"], {"agentId": outsider["id"], "role": "implementer", "responsibilities": "Work", "enabled": True},
                ]}, expected_version=project["version"])
        elif invalid == "foreign_project":
            other = project_for_agents(app.state.project_store, "foreign", [app.state.agent_store.get_agent(agent_id)], name="Foreign")
            payload["projectId"] = other["id"]
        elif invalid == "archived_project":
            app.state.project_store.archive_project(project["id"], expected_version=project["version"])
        else:
            app.state.project_store.update_project(project["id"], {"enabled": False}, expected_version=project["version"])
        response = client.post("/api/v1/teams", json=payload)
        assert response.status_code in (400, 403, 404), response.text
        assert app.state.team_store.list_teams() == []


@pytest.mark.parametrize("credential", ["chat", "admin_token", "other_admin", "node"])
def test_nonowner_or_service_cannot_mutate_workflow(monkeypatch, credential):
    with workflow_world(monkeypatch) as (app, client, _, _, project, payload):
        team = client.post("/api/v1/teams", json=payload).json()["team"]
        before = app.state.team_store.get_team(team["id"])
        events = app.state.team_store.events(team["id"])
        stranger = TestClient(app)
        prefix = "/api/v1/teams"
        if credential == "chat":
            stranger.headers.update({"Authorization": "Bearer chat-test", "x-relay-user-id": _admin_id(app)})
        elif credential == "admin_token":
            stranger.headers.update({"Authorization": "Bearer admin_token"})
            prefix = "/api/v1/admin/teams"
        elif credential == "node":
            stranger.headers.update({"Authorization": "Bearer token_node_here"})
        else:
            app.state.auth_store.create_account(
                "other", "kestrel-vault-8820", role="admin", email="other@example.com",
            )
            login = stranger.post("/api/v1/auth/login", json={"username": "other", "password": "kestrel-vault-8820"})
            assert login.status_code == 200, login.text
            prefix = "/api/v1/admin/teams"
            assert stranger.get(prefix).status_code == 200
        body = {**payload, "name": "Attempt", **({"ownerUserId": _admin_id(app)} if "/admin/" in prefix else {})}
        for response in (
            stranger.post(prefix, json=body),
            stranger.patch(f"{prefix}/{team['id']}", json={"name": "Attempt"}),
            stranger.delete(f"{prefix}/{team['id']}"),
            stranger.delete(f"/profile-images/teams/{team['id']}"),
        ):
            assert response.status_code in (401, 403), response.text
        assert app.state.team_store.get_team(team["id"]) == before
        assert app.state.team_store.events(team["id"]) == events


@pytest.mark.parametrize("path", ["run", "message", "address", "recovery", "approval", "retarget"])
def test_workflow_execution_queues_zero_commands(monkeypatch, path):
    with workflow_world(monkeypatch) as (app, client, here, _, project, payload):
        team = client.post("/api/v1/teams", json=payload).json()["team"]
        if path in {"project_task", "routine"}:
            task = app.state.task_store.create_task({
                "title": "Must not run", "ownerUserId": _admin_id(app),
                "assigneeUserId": _admin_id(app), "assignedTeamId": team["id"],
                **({"projectId": project["id"]} if path == "project_task" else {"sourceRoutineId": "routine"}),
            })
            response = client.post(f"/api/v1/tasks/{task['id']}/runs", json={})
        elif path == "run":
            response = client.post("/api/v1/agent-runs", json={"taskGoal": "Must not run", "teamId": team["id"]})
        else:
            controller = SessionController(app.state.session_store, owner_user_id=_admin_id(app),
                                           team_id=team["id"] if path != "address" else None,
                                           workspace_path="/workspace/node_here")
            session = controller.create_session("Must not run", ["human"])
            if path == "recovery":
                response = client.post("/api/v1/agent-runs", json={"taskGoal": "Must not run", "sessionId": session["id"], "assignments": [{"agentId": payload["leadAgentId"]}], "decision": {"kind": "rerun", "targetAgentId": payload["leadAgentId"]}})
            else:
                response = client.post(f"/api/v1/threads/{session['id']}/messages", json={
                    "text": "Must not run", "intent": "accomplish",
                    **({"addressTeamId": team["id"]} if path == "address" else {}),
                    **({"questionId": "current-gate", "approve": True} if path == "approval" else {}),
                    **({"addressAgentIds": [payload["leadAgentId"]]} if path == "retarget" else {}),
                })
        if path in {"project_task", "routine"}:
            assert response.status_code == 202, response.text
            assert response.json()["dispatch"]["state"] == "rejected"
            assert response.json()["task"]["status"] == "blocked"
        else:
            assert response.status_code in (400, 409), response.text
        assert "team_workflow_execution_unavailable" in response.text, response.text
        assert app.state.registry.take_commands(here["id"], "token_node_here") == []


@pytest.mark.parametrize("admin", [False, True])
@pytest.mark.parametrize("patch", [
    {"workflowSteps": [{"id": "x", "surprise": True}]},
    {"projectId": []}, {"workflowSteps": {"steps": []}},
    {"memberAgentIds": [{}]}, {"unknownWorkflowField": True},
])
def test_malformed_api_writes_preserve_events(monkeypatch, admin, patch):
    with workflow_world(monkeypatch) as (app, client, _, _, _, payload):
        prefix = "/api/v1/admin/teams" if admin else "/api/v1/teams"
        owner = {"ownerUserId": _admin_id(app)} if admin else {}
        team = client.post(prefix, json={**payload, **owner}).json()["team"]
        before = app.state.team_store.get_team(team["id"])
        events = app.state.team_store.events(team["id"])
        response = client.patch(f"{prefix}/{team['id']}", json=patch)
        assert response.status_code == 400, response.text
        response = client.post(prefix, json={**payload, **owner, "name": "Invalid", **patch})
        assert response.status_code == 400, response.text
        assert app.state.team_store.get_team(team["id"]) == before
        assert app.state.team_store.events(team["id"]) == events
        assert len(app.state.team_store.list_teams()) == 1


@pytest.mark.parametrize("change", ["disabled_member", "disabled_agent", "unplaced", "computer", "foreign_step"])
def test_every_update_rechecks_live_roster(monkeypatch, change):
    with workflow_world(monkeypatch) as (app, client, here, there, project, payload):
        team = client.post("/api/v1/teams", json=payload).json()["team"]
        before = app.state.team_store.get_team(team["id"])
        events = app.state.team_store.events(team["id"])
        patch = {"name": "Renamed"}
        if change == "disabled_member":
            app.state.project_store.update_project(project["id"], {"members": [
                {**member, "enabled": False} for member in project["members"]
            ]}, expected_version=project["version"])
        elif change == "disabled_agent":
            app.state.agent_store.update_agent(payload["leadAgentId"], {"enabled": False})
        elif change == "computer":
            patch["computerId"] = computer_id(there)
        elif change == "foreign_step":
            patch["workflowSteps"] = [{**team["workflowSteps"][0], "agentId": "foreign"}]
        else:
            for placement in app.state.agent_placement_store.list_placements(agent_id=payload["leadAgentId"]):
                app.state.agent_placement_store.update_placement(placement["id"], {"desiredState": "removed"})
        response = client.patch(f"/api/v1/teams/{team['id']}", json=patch)
        assert response.status_code == 400, response.text
        assert app.state.team_store.get_team(team["id"]) == before
        assert app.state.team_store.events(team["id"]) == events


def test_foreign_project_assignment_and_standalone_assignment_rejected(monkeypatch):
    with workflow_world(monkeypatch) as (app, client, _, _, project, payload):
        team = client.post("/api/v1/teams", json=payload).json()["team"]
        other = project_for_agents(app.state.project_store, _admin_id(app),
                                   [app.state.agent_store.get_agent(payload["leadAgentId"])], name="Other")
        for project_id in (other["id"], None):
            response = client.post("/api/v1/tasks", json={
                "title": "No workflow yet", "assignedTeamId": team["id"],
                **({"projectId": project_id} if project_id else {}),
            })
            assert response.status_code in (400, 409), response.text
            expected = "team_workflow_project_mismatch"
            assert expected in response.text


def test_service_actor_with_owner_cookie_is_still_not_workflow_authority(monkeypatch):
    with workflow_world(monkeypatch) as (app, client, _, _, _, payload):
        team = client.post("/api/v1/teams", json=payload).json()["team"]
        client.headers.update({"Authorization": "Bearer chat-test", "x-relay-user-id": _admin_id(app)})
        response = client.patch(f"/api/v1/teams/{team['id']}", json={"name": "Service change"})
        assert response.status_code == 403
        assert app.state.team_store.get_team(team["id"])["name"] == "Workflow"


def test_workflow_profile_mutations_require_owner_session(monkeypatch):
    with workflow_world(monkeypatch) as (app, client, _, _, _, payload):
        team = client.post("/api/v1/teams", json=payload).json()["team"]
        before = app.state.team_store.events(team["id"])
        service = TestClient(app)
        service.headers.update({"Authorization": "Bearer chat-test", "x-relay-user-id": _admin_id(app)})
        path = f"/profile-images/teams/{team['id']}"
        assert service.delete(path).status_code == 403
        assert service.put(path, json={"presetUrl": "/avatars/teams/01.svg"}).status_code == 403
        assert app.state.team_store.events(team["id"]) == before
