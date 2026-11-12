"""Project work cannot escape its enabled Agent roster through assignment."""
# ruff: noqa: F811 -- imported pytest fixture is injected by parameter name.
import asyncio

import pytest

from automation_helpers import WEEKLY_TRIGGERS
from test_project_execution_policy import project_context  # noqa: F401
from test_project_routes import _team


@pytest.mark.parametrize("routine", [False, True])
@pytest.mark.parametrize("target", ["agent", "team"])
@pytest.mark.parametrize("entry", ["create", "patch", "assignment"])
def test_project_work_refuses_non_member(project_context, routine, target, entry):
    app, client, node, project, lead, worker = project_context
    outsider = worker
    removed = client.patch(f"/api/v1/projects/{project['id']}", json={
        "expectedVersion": project["version"],
        "members": [member for member in project["members"] if member["agentId"] != worker["id"]],
    })
    assert removed.status_code == 200, removed.text
    team = _team(client, lead, outsider) if target == "team" else None
    field = "assignedTeamId" if team else "assignedAgentId"
    value = team["id"] if team else outsider["id"]
    payload = {"title": "Roster-bound work", "projectId": project["id"]}
    if routine:
        payload.update(isRoutine=True, routineTriggers=WEEKLY_TRIGGERS, routineState="paused")
    if entry == "create":
        response = client.post("/api/v1/tasks", json={**payload, field: value})
    else:
        created = client.post("/api/v1/tasks", json=payload)
        assert created.status_code == 201, created.text
        task_id = created.json()["id"]
        if entry == "patch":
            response = client.patch(f"/api/v1/tasks/{task_id}", json={field: value})
        else:
            response = client.put(f"/api/v1/tasks/{task_id}/assignment", json={
                "teamId" if team else "agentId": value,
            })
        saved = client.get(f"/api/v1/tasks/{task_id}").json()
        assert not saved.get(field), saved
    assert response.status_code == 400, response.text
    assert response.json()["detail"] == ("project_team_not_member" if team else "project_agent_not_member")


@pytest.mark.parametrize("target", ["agent", "team"])
@pytest.mark.parametrize("entry", ["manual", "scheduler", "routine"])
def test_dispatch_rechecks_project_membership(project_context, target, entry):
    app, client, node, project, lead, worker = project_context
    team = _team(client, lead, worker) if target == "team" else None
    payload = {
        "title": "Saved assignment", "projectId": project["id"], "status": "assigned",
        **({"assignedTeamId": team["id"]} if team else {"assignedAgentId": worker["id"]}),
    }
    if entry == "routine":
        payload.update(isRoutine=True, routineState="active", routineTriggers=WEEKLY_TRIGGERS)
    created = client.post("/api/v1/tasks", json=payload)
    assert created.status_code == 201, created.text
    removed = client.patch(f"/api/v1/projects/{project['id']}", json={
        "expectedVersion": project["version"],
        "members": [member for member in project["members"] if member["agentId"] != worker["id"]],
    })
    assert removed.status_code == 200, removed.text
    code = "project_team_not_member" if team else "project_agent_not_member"
    if entry == "scheduler":
        result = asyncio.run(app.state.task_scheduler.tick())
        assert result.dispatched == 0
        saved = app.state.task_store.get_task(created.json()["id"])
        assert saved["status"] == "blocked"
        assert code in saved["blockerReason"]
    else:
        response = client.post(f"/api/v1/tasks/{created.json()['id']}/runs", json={})
        assert response.status_code == 202, response.text
        assert response.json()["dispatch"]["state"] == "rejected", response.text
        assert response.json()["dispatch"]["code"] == code, response.text
    assert app.state.registry.take_commands(node["id"], f"token_{node['id']}") == []
