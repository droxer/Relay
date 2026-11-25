from datetime import UTC, datetime, timedelta
from uuid import uuid4

import pytest

from automation_helpers import DAILY_TRIGGERS
from test_scheduled_workflows import occurrence_of, tick
from test_task_workflows import take
from test_team_workflows import workflow_world
from test_unified_workflows import unified_world
from test_workflow_progression import finish


@pytest.mark.parametrize(
    "style,lead_role,order,kinds",
    [
        ("build_review", "reviewer", (1, 0), ("implementation", "synthesis")),
        ("pipeline", "tester", (1, 0), ("implementation", "verification")),
        ("lead_led", "planner", (0, 1, 0), ("coordination", "implementation", "synthesis")),
        ("build_review", "implementer", (0,), ("synthesis",)),
        ("lead_led", "planner", (0,), ("synthesis",)),
    ],
)
def test_project_preset_runs_on_its_roster(monkeypatch, style, lead_role, order, kinds):
    with unified_world(monkeypatch) as (app, client, node, _, project, payload):
        lead, member = project["members"]
        app.state.project_store.update_project(project["id"], {
            "members": [{**lead, "role": lead_role}, {**member, "enabled": len(order) > 1}],
        }, expected_version=project["version"])
        workflow_id = f"preset:{style}"
        catalog = client.get(f"/api/v1/workflows?view=choices&projectId={project['id']}").json()
        assert catalog["workflows"] == []
        assert {item["id"] for item in catalog["predefinedWorkflows"]} == {
            "preset:build_review", "preset:pipeline", "preset:lead_led",
        }
        path = f"/api/v1/workflows/{workflow_id}/runs"
        body = {"projectId": project["id"], "taskGoal": "Deliver and verify", "requestId": str(uuid4())}
        response = client.post(path, json=body)
        assert response.status_code == 201, response.text
        session = response.json()
        assert session["projectId"] == project["id"]
        assert session["workspaceLayout"] == "project"
        assert not session.get("teamId")
        round_info, = session["collaborationRounds"]
        assert "teamSnapshot" not in round_info
        assert round_info["projectSnapshot"]["workflowId"] == workflow_id
        assert round_info["strategy"] == "coordinate"
        if style == "build_review" and len(order) == 1:
            assert round_info["style"] == "solo"
            assert round_info["styleFallbackFrom"] == style
        else:
            assert round_info["style"] == style
        assert client.post(path, json=body).json()["id"] == session["id"]
        conflict = client.post(path, json={**body, "taskGoal": "Different goal"})
        assert conflict.status_code == 409
        assert conflict.json()["detail"] == "workflow_request_conflict"

        registry = app.state.registry
        for member_index, kind in zip(order, kinds, strict=True):
            command, = take(registry, node)
            assert command["sessionId"] == session["id"]
            assert command["logicalAgentId"] == payload["memberAgentIds"][member_index]
            assert command["state"]["work_kind"] == kind
            work = {"status": "done", "evidence": ["Verified in the Project workspace"]}
            if kind == "coordination":
                candidate, = command["state"]["team_plan_candidates"]
                work["plan"] = [{
                    "agentId": candidate["agentId"], "objective": "Implement the requested change",
                    "acceptanceCriteria": ["Feature works"], "expectedOutputs": ["Validated change"],
                }]
            finish(registry, node, command, {}, roundResult={"status": "done", "work": work})
        final = app.state.session_store.get_session(session["id"])
        assert final["status"] == "completed", final.get("workOutcome")
        assert take(registry, node) == []
        assert app.state.team_store.list_teams() == []


def test_project_preset_task_patch_and_automation_dispatch(monkeypatch):
    with unified_world(monkeypatch) as (app, client, node, _, project, payload):
        fields = {"projectId": project["id"], "assignedWorkflowId": "preset:pipeline"}
        created = client.post("/api/v1/tasks", json={
            "title": "Manual Pipeline", "projectId": project["id"], "assignedAgentId": payload["leadAgentId"],
        })
        assert created.status_code == 201, created.text
        path = f"/api/v1/tasks/{created.json()['id']}"
        updated = client.patch(path, json={"assignedWorkflowId": "preset:pipeline"})
        assert updated.status_code == 200, updated.text
        assert not updated.json().get("assignedAgentId")
        assert updated.json()["assignedWorkflowId"] == "preset:pipeline"
        started = client.post(path + "/runs", json={})
        assert started.status_code == 202, started.text
        manual = started.json()["session"]
        assert manual["collaborationRounds"][-1]["style"] == "pipeline"
        assert not manual.get("teamId")
        for _ in project["members"]:
            command, = take(app.state.registry, node)
            finish(app.state.registry, node, command, {})

        created = client.post("/api/v1/tasks", json={
            **fields, "title": "Daily Pipeline", "isRoutine": True,
            "routineState": "active", "routineTriggers": DAILY_TRIGGERS,
        })
        assert created.status_code == 201, created.text
        app.state.task_scheduler.automations.tick(datetime.now(UTC) + timedelta(days=2))
        assert tick(app).dispatched == 1
        occurrence = occurrence_of(app, created.json()["id"])
        assert occurrence["assignedWorkflowId"] == "preset:pipeline"
        session_id, = occurrence["linkedSessionIds"]
        session = app.state.session_store.get_session(session_id)
        round_info, = session["collaborationRounds"]
        assert round_info["style"] == "pipeline"
        assert round_info["strategy"] == "coordinate"
        assert "teamSnapshot" not in round_info


def test_project_preset_validation_and_daemon_capability(monkeypatch):
    with workflow_world(monkeypatch) as (app, client, node, _, project, payload):
        project_id = project["id"]
        path = "/api/v1/workflows/preset:lead_led/runs"
        body = {"requestId": str(uuid4()), "taskGoal": "Lead the work", "projectId": project_id}
        assert client.post(path, json={**body, "teamId": "ignored"}).json()["detail"] == "workflow_team_forbidden"
        assert client.post(path, json={**body, "projectId": None}).json()["detail"] == "workflow_project_required"
        assert client.post(path, json=body).status_code == 409
        assert "work-results support" in client.post(path, json=body).json()["detail"]
        assert take(app.state.registry, node) == []

        task = {"title": "Lead the work", "assignedWorkflowId": "preset:lead_led"}
        assert client.post("/api/v1/tasks", json=task).json()["detail"] == "workflow_team_required"
        task["projectId"] = project_id
        assert client.post("/api/v1/tasks", json={
            **task, "assignedAgentId": payload["leadAgentId"],
        }).json()["detail"] == "workflow_agent_conflict"
        ready = client.post("/api/v1/tasks", json={**task, "status": "assigned"})
        assert ready.status_code == 201, ready.text
        lead, other = project["members"]
        project = app.state.project_store.update_project(project_id, {
            "members": [{**lead, "enabled": False}, other],
        }, expected_version=project["version"])
        assert client.post("/api/v1/tasks", json=task).json()["detail"] == "project_lead_required"
        assert client.post(path, json=body).json()["detail"] == "project_lead_required"
        tick(app)
        blocked = app.state.task_store.get_task(ready.json()["id"])
        assert blocked["status"] == "blocked"
        assert blocked["attention"]["code"] == "project_lead_required"
        assert take(app.state.registry, node) == []
        app.state.project_store.update_project(project_id, {
            "members": [{**member, "enabled": False} for member in project["members"]],
        }, expected_version=project["version"])
        assert client.post("/api/v1/tasks", json=task).json()["detail"] == "project_roster_invalid"
