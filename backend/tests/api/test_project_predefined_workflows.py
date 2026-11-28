from datetime import UTC, datetime, timedelta
from uuid import uuid4

import pytest

from task_setup import mark_task_ready
from automation_helpers import DAILY_TRIGGERS
from test_scheduled_workflows import occurrence_of, tick
from test_task_workflows import take
from test_team_workflows import workflow_world
from test_unified_workflows import unified_world
from test_workflow_progression import finish


@pytest.mark.parametrize(
    "style,lead_role,member_role,order,kinds",
    [
        ("build_review", "reviewer", "implementer", (1, 0), ("implementation", "synthesis")),
        ("build_review", "tester", "fixer", (1, 0), ("implementation", "synthesis")),
        ("pipeline", "tester", "implementer", (1, 0), ("implementation", "verification")),
        ("lead_led", "planner", "implementer", (0, 1, 0), ("coordination", "implementation", "synthesis")),
        ("build_review", "fixer", "implementer", (0,), ("synthesis",)),
        ("lead_led", "planner", "implementer", (0,), ("synthesis",)),
    ],
)
def test_project_preset_runs_on_its_roster(monkeypatch, style, lead_role, member_role, order, kinds):
    with unified_world(monkeypatch) as (app, client, node, _, project, payload):
        lead, member = project["members"]
        updated_agent = client.patch(f"/api/v1/agents/{lead['agentId']}", json={"defaultRole": lead_role})
        assert updated_agent.status_code == 200, updated_agent.text
        updated_member = client.patch(f"/api/v1/agents/{member['agentId']}", json={
            "defaultRole": member_role, "roleLevel": "senior",
        })
        assert updated_member.status_code == 200, updated_member.text
        app.state.project_store.update_project(project["id"], {
            "members": [lead, {**member, "enabled": len(order) > 1}],
        }, expected_version=project["version"])
        workflow_id = f"preset:{style}"
        catalog = client.get(f"/api/v1/workflows?view=choices&projectId={project['id']}").json()
        assert catalog["workflows"] == []
        assert {item["id"] for item in catalog["predefinedWorkflows"]} == {
            "preset:build_review", "preset:lead_led",
        }
        path = f"/api/v1/workflows/{workflow_id}/runs"
        body = {"projectId": project["id"], "taskGoal": "Deliver and verify", "requestId": str(uuid4())}
        if style == "pipeline":
            refused = client.post(path, json=body)
            assert (refused.status_code, refused.json()["detail"]) == (409, "workflow_retired")
            # Create an old run through the same dispatch path before restoring the new-selection guard.
            with monkeypatch.context() as legacy:
                legacy.setattr("relay.api.projects.workflow_runs.require_selectable_workflow", lambda _: None)
                response = client.post(path, json=body)
        else:
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
            assert command["state"]["agent_role"] == (lead_role, member_role)[member_index]
            if member_index == 1:
                assert command["state"]["agent_role_level"] == "senior"
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


def test_saved_pipeline_task_and_automation_dispatch(monkeypatch):
    with unified_world(monkeypatch) as (app, client, node, _, project, payload):
        selected_agent_id = payload["memberAgentIds"][1]
        project_url = f"/api/v1/projects/{project['id']}"
        refused = client.patch(project_url, json={
            "expectedVersion": project["version"],
            "predefinedWorkflowChange": {"workflowId": "preset:pipeline", "agentIds": [selected_agent_id]},
        })
        assert (refused.status_code, refused.json()["detail"]) == (400, "workflow_retired")
        project = app.state.project_store.update_project(project["id"], {
            "predefinedWorkflows": {"pipeline": {"agentIds": [selected_agent_id]}},
        }, expected_version=project["version"])
        assert client.get(project_url).json()["project"]["predefinedWorkflows"] == project["predefinedWorkflows"]
        fields = {"projectId": project["id"], "assignedWorkflowId": "preset:pipeline"}
        refused = client.post("/api/v1/tasks", json={**fields, "title": "New Pipeline"})
        assert (refused.status_code, refused.json()["detail"]) == (409, "workflow_retired")
        created = client.post("/api/v1/tasks", json={
            "title": "Manual Pipeline", "projectId": project["id"], "assignedAgentId": payload["leadAgentId"],
        })
        assert created.status_code == 201, created.text
        path = f"/api/v1/tasks/{created.json()['id']}"
        refused = client.patch(path, json={"assignedWorkflowId": "preset:pipeline"})
        assert (refused.status_code, refused.json()["detail"]) == (409, "workflow_retired")
        app.state.task_store.update_task(created.json()["id"], {
            "assignedWorkflowId": "preset:pipeline", "assignedAgentId": None,
        })
        updated = client.patch(path, json={"title": "Rename the saved Pipeline"})
        assert updated.status_code == 200, updated.text
        assert not updated.json().get("assignedAgentId")
        assert updated.json()["assignedWorkflowId"] == "preset:pipeline"
        started = client.post(path + "/runs", json={})
        assert started.status_code == 202, started.text
        manual = started.json()["session"]
        assert manual["collaborationRounds"][-1]["style"] == "pipeline"
        assert not manual.get("teamId")
        command, = take(app.state.registry, node)
        assert command["logicalAgentId"] == selected_agent_id
        finish(app.state.registry, node, command, {})
        assert take(app.state.registry, node) == []

        app.state.project_store.update_project(project["id"], {
            "predefinedWorkflows": {"pipeline": {"agentIds": list(reversed(payload["memberAgentIds"]))}},
        }, expected_version=project["version"])
        routine_fields = {
            **fields, "title": "Daily Pipeline", "isRoutine": True,
            "routineState": "active", "routineTriggers": DAILY_TRIGGERS,
        }
        refused = client.post("/api/v1/tasks", json=routine_fields)
        assert (refused.status_code, refused.json()["detail"]) == (409, "workflow_retired")
        created = client.post("/api/v1/tasks", json={**routine_fields, "assignedWorkflowId": "preset:build_review"})
        assert created.status_code == 201, created.text
        routine_id = created.json()["id"]
        app.state.task_store.update_task(routine_id, {"assignedWorkflowId": "preset:pipeline"})
        saved = client.patch(f"/api/v1/tasks/{routine_id}", json={"title": "Rename the saved Automation"})
        assert saved.status_code == 200, saved.text
        assert saved.json()["assignedWorkflowId"] == "preset:pipeline"
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
        assert round_info["projectSnapshot"]["participantAgentIds"] == payload["memberAgentIds"]
        for agent_id in payload["memberAgentIds"]:
            command, = take(app.state.registry, node)
            assert command["logicalAgentId"] == agent_id
            finish(app.state.registry, node, command, {}, roundResult={
                "status": "done", "work": {"status": "done", "evidence": ["Verified in the Project workspace"]},
            })
        assert take(app.state.registry, node) == []


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
        created = client.post("/api/v1/tasks", json=task)
        assert created.status_code == 201, created.text
        ready = mark_task_ready(client, created.json())
        lead, other = project["members"]
        project = app.state.project_store.update_project(project_id, {
            "members": [{**lead, "enabled": False}, other],
        }, expected_version=project["version"])
        assert client.post("/api/v1/tasks", json=task).json()["detail"] == "project_lead_required"
        assert client.post(path, json=body).json()["detail"] == "project_lead_required"
        tick(app)
        blocked = app.state.task_store.get_task(ready["id"])
        assert blocked["status"] == "blocked"
        assert blocked["attention"]["code"] == "project_lead_required"
        assert take(app.state.registry, node) == []
        app.state.project_store.update_project(project_id, {
            "members": [{**member, "enabled": False} for member in project["members"]],
        }, expected_version=project["version"])
        assert client.post("/api/v1/tasks", json=task).json()["detail"] == "project_roster_invalid"


def test_project_preset_selection_patch_validates_prunes_and_scopes_runs(monkeypatch):
    with unified_world(monkeypatch) as (app, client, node, _, project, _):
        url = f"/api/v1/projects/{project['id']}"
        _, member = project["members"]
        change = {"workflowId": "preset:build_review", "agentIds": [member["agentId"]]}

        def patch(version, body):
            return client.patch(url, json={"expectedVersion": version, **body})

        for workflow_id in ("preset:nope", []):
            bad = patch(project["version"], {"predefinedWorkflowChange": {**change, "workflowId": workflow_id}})
            assert (bad.status_code, bad.json()["detail"]) == (400, "project_workflow_change_invalid")
        bad = patch(project["version"], {"predefinedWorkflowChange": {**change, "agentIds": []}})
        assert (bad.status_code, bad.json()["detail"]) == (400, "project_workflow_change_invalid")
        bad = patch(project["version"], {"predefinedWorkflowChange": {**change, "agentIds": ["stranger"]}})
        assert (bad.status_code, bad.json()["detail"]) == (400, "project_workflow_agent_not_member")
        stale = patch(project["version"] + 5, {"predefinedWorkflowChange": change})
        assert (stale.status_code, stale.json()["detail"]) == (409, "project_version_conflict")

        saved = patch(project["version"], {"predefinedWorkflowChange": change})
        assert saved.status_code == 200, saved.text
        record = saved.json()["project"]
        assert record["predefinedWorkflows"] == {"build_review": {"agentIds": [member["agentId"]]}}
        listed = client.get("/api/v1/projects").json()["projects"]
        assert next(item for item in listed if item["id"] == project["id"])["predefinedWorkflows"] == record["predefinedWorkflows"]

        run_path = "/api/v1/workflows/preset:build_review/runs"
        started = client.post(run_path, json={
            "projectId": project["id"], "taskGoal": "Run with selected Agents", "requestId": str(uuid4()),
        })
        assert started.status_code == 201, started.text
        thread = started.json()
        round_info, = thread["collaborationRounds"]
        assert round_info["projectSnapshot"]["participantAgentIds"] == [member["agentId"]]
        registry = app.state.registry
        command, = take(registry, node)
        assert command["sessionId"] == thread["id"]
        assert command["logicalAgentId"] == member["agentId"]
        finish(registry, node, command, {})
        assert app.state.session_store.get_session(thread["id"])["status"] == "completed"
        assert take(registry, node) == []

        disabled = patch(record["version"], {
            "memberChange": {"op": "update", "agentId": member["agentId"], "fields": {"enabled": False}},
        })
        assert disabled.status_code == 200, disabled.text
        record = disabled.json()["project"]
        assert record["predefinedWorkflows"] == {"build_review": {"agentIds": [member["agentId"]]}}
        refused = client.post(run_path, json={
            "projectId": project["id"], "taskGoal": "Check disabled selection", "requestId": str(uuid4()),
        })
        assert (refused.status_code, refused.json()["detail"]) == (409, "project_roster_invalid")
        assert take(registry, node) == []
        enabled = patch(record["version"], {
            "memberChange": {"op": "update", "agentId": member["agentId"], "fields": {"enabled": True}},
        })
        assert enabled.status_code == 200, enabled.text
        record = enabled.json()["project"]

        reset = patch(record["version"], {"predefinedWorkflowChange": {**change, "agentIds": None}})
        assert not reset.json()["project"].get("predefinedWorkflows")

        again = patch(reset.json()["project"]["version"], {"predefinedWorkflowChange": change}).json()["project"]
        removed = client.patch(url + "?view=member-update", json={
            "expectedVersion": again["version"], "memberChange": {"op": "remove", "agentId": member["agentId"]},
        })
        assert removed.status_code == 200, removed.text
        assert removed.json()["project"]["predefinedWorkflows"] == {}


def test_project_build_review_required_reviewer_blocks_and_can_retry(monkeypatch):
    with unified_world(monkeypatch) as (app, client, node, _, project, _):
        project_id = project["id"]
        lead, reviewer = project["members"]
        registry = app.state.registry
        workflow_id = "preset:build_review"
        project_url = f"/api/v1/projects/{project_id}"
        run_path = f"/api/v1/workflows/{workflow_id}/runs"
        body = {"projectId": project_id, "taskGoal": "Verify empty input", "requestId": str(uuid4())}
        change = {"workflowId": workflow_id, "agentIds": [lead["agentId"]], "requireIndependentReview": True}
        saved = client.patch(project_url, json={
            "expectedVersion": project["version"], "predefinedWorkflowChange": change,
        })
        assert saved.status_code == 200, saved.text
        configured = saved.json()["project"]
        assert configured["predefinedWorkflows"]["build_review"] == {
            "agentIds": [lead["agentId"]], "requireIndependentReview": True,
        }

        refused = client.post(run_path, json=body)
        assert (refused.status_code, refused.json()["detail"]) == (409, "project_reviewer_required")

        fields = {"projectId": project_id, "assignedWorkflowId": workflow_id}
        created = client.post("/api/v1/tasks", json={**fields, "title": "Needs a reviewer"})
        assert created.status_code == 201, created.text
        ready = mark_task_ready(client, created.json())
        routine = client.post("/api/v1/tasks", json={
            **fields, "title": "Daily review", "isRoutine": True,
            "routineState": "active", "routineTriggers": DAILY_TRIGGERS,
        })
        assert routine.status_code == 201, routine.text
        app.state.task_scheduler.automations.tick(datetime.now(UTC) + timedelta(days=2))
        tick(app)
        tasks = [app.state.task_store.get_task(ready["id"]), occurrence_of(app, routine.json()["id"])]
        for task in tasks:
            assert task["status"] == "blocked"
            assert task["attention"]["code"] == "project_reviewer_required"
            assert not task.get("linkedSessionIds")
        assert take(registry, node) == []

        # A policy-only selection follows the enabled roster.
        reset = client.patch(project_url, json={
            "expectedVersion": configured["version"],
            "predefinedWorkflowChange": {"workflowId": workflow_id, "agentIds": None},
        })
        assert reset.status_code == 200, reset.text
        assert reset.json()["project"]["predefinedWorkflows"]["build_review"] == {
            "agentIds": None, "requireIndependentReview": True,
        }
        started = client.post(run_path, json=body)
        assert started.status_code == 201, started.text
        thread = started.json()
        assert thread["collaborationRounds"][0]["projectSnapshot"]["requireIndependentReview"] is True
        builder_command, = take(registry, node)
        assert builder_command["logicalAgentId"] == lead["agentId"]
        finish(registry, node, builder_command, {})
        assert app.state.session_store.get_session(thread["id"])["status"] == "running"
        review_command, = take(registry, node)
        assert review_command["logicalAgentId"] == reviewer["agentId"]
        assert review_command["state"]["team_phase"] == "review"
        finish(registry, node, review_command, {})
        assert app.state.session_store.get_session(thread["id"])["status"] == "completed"
        assert take(registry, node) == []
