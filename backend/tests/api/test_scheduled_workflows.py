"""Scheduled Project Tasks and Automations enter the same workflow ledger as a manual start."""
import asyncio
from datetime import UTC, datetime, timedelta

import pytest

from automation_helpers import DAILY_TRIGGERS
from relay.daemon_registry.dispatch.workflow_admission import workflow_request_id
from test_task_workflows import take, task_workflow
from test_team_workflows import workflow_world
from test_workflow_progression import decision, finish


def tick(app):
    return asyncio.run(app.state.task_scheduler.tick())


def workflow_session(app, task_id):
    task = app.state.task_store.get_task(task_id)
    sid, = task["linkedSessionIds"]
    return task, app.state.session_store.get_session(sid)


def occurrence_of(app, routine_id):
    occurrences = [
        task for task in app.state.task_store.list_tasks()
        if task.get("sourceRoutineId") == routine_id
    ]
    assert len(occurrences) == 1, occurrences
    return occurrences[0]


def test_scheduler_runs_assigned_workflow_task_through_the_ledger(monkeypatch):
    with workflow_world(monkeypatch) as (app, client, node, _, project, payload):
        task, _ = task_workflow(client, project, payload, status="assigned")
        assert tick(app).dispatched == 1
        current, session = workflow_session(app, task["id"])
        assert current["status"] != "blocked", current.get("blockerReason")
        assert current["executionOwner"]["requestId"] == workflow_request_id(session["workflowRuns"][0])
        command, = take(app.state.registry, node)
        assert command["workspaceSubpath"] == project["workspaceSubpath"]
        finish(app.state.registry, node, command, {"Design": "design artifact"})
        assert app.state.task_store.get_task(task["id"])["status"] == "waiting_for_human"
        # A parked workflow is not re-dispatched by later ticks.
        assert tick(app).dispatched == 0
        assert take(app.state.registry, node) == []


def test_scheduler_parks_a_gated_first_step_without_a_command(monkeypatch):
    with workflow_world(monkeypatch) as (app, client, node, _, project, payload):
        payload["workflowSteps"][0]["requiresApproval"] = True
        task, _ = task_workflow(client, project, payload, status="assigned")
        tick(app)
        current, session = workflow_session(app, task["id"])
        assert current["status"] == "waiting_for_human"
        assert take(app.state.registry, node) == []
        tick(app)
        assert take(app.state.registry, node) == []
        response = client.post(f"/api/v1/threads/{session['id']}/workflow-decisions", json=decision(session, "approve"))
        assert response.status_code == 200, response.text
        assert len(take(app.state.registry, node)) == 1


@pytest.mark.parametrize("entry", ["schedule", "manual"])
def test_workflow_automation_occurrence_runs_and_completes(monkeypatch, entry):
    with workflow_world(monkeypatch) as (app, client, node, _, project, payload):
        routine, _ = task_workflow(
            client, project, payload, isRoutine=True, routineState="active",
            routineTriggers=DAILY_TRIGGERS,
        )
        if entry == "schedule":
            assert app.state.task_scheduler.automations.tick(datetime.now(UTC) + timedelta(days=2)) >= 1
            tick(app)
        else:
            response = client.post(f"/api/v1/tasks/{routine['id']}/runs", json={})
            assert response.status_code == 202, response.text
            tick(app)
        occurrence = occurrence_of(app, routine["id"])
        assert occurrence["status"] != "blocked", occurrence.get("blockerReason")
        occurrence, session = workflow_session(app, occurrence["id"])
        assert session["workflowRuns"], session
        design, = take(app.state.registry, node)
        finish(app.state.registry, node, design, {"Design": "design artifact"})
        session = app.state.session_store.get_session(session["id"])
        response = client.post(f"/api/v1/threads/{session['id']}/workflow-decisions", json=decision(session, "approve"))
        assert response.status_code == 200, response.text
        deploy, = take(app.state.registry, node)
        finish(app.state.registry, node, deploy, {"URL": "https://example.test"})
        done = app.state.task_store.get_task(occurrence["id"])
        assert done["status"] in ("done", "review")
        assert app.state.session_store.get_session(session["id"])["status"] == "completed"


@pytest.mark.parametrize("scope", ["standalone", "foreign"])
def test_workflow_team_automation_cannot_span_scopes(monkeypatch, scope):
    with workflow_world(monkeypatch) as (app, client, _, _, project, payload):
        team = client.post("/api/v1/teams", json=payload).json()["team"]
        body = {"title": "Nightly", "assignedTeamId": team["id"], "isRoutine": True,
                "routineState": "active", "routineTriggers": DAILY_TRIGGERS}
        if scope == "foreign":
            from issue_projects import project_for_agents
            other = project_for_agents(app.state.project_store, project["ownerUserId"],
                                       [app.state.agent_store.get_agent(payload["leadAgentId"])], name="Other")
            body["projectId"] = other["id"]
        response = client.post("/api/v1/tasks", json=body)
        assert response.status_code in (400, 409), response.text
        # A Project never names a Team; standalone work never names a Workflow Team.
        expected = "project_team_assignment_forbidden" if scope == "foreign" else "standalone_team_workflow"
        assert expected in response.text
