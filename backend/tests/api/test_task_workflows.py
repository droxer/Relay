"""Project Task admission uses the frozen workflow ledger, not legacy Team rounds."""
from datetime import UTC, datetime, timedelta
from inspect import currentframe

import pytest

from relay.daemon_registry.dispatch.workflow_admission import workflow_request_id
from relay.persistence.daemon import run_requests
from relay.persistence.events import relay_task_event
from test_team_workflows import workflow_world
from test_workflow_progression import decision, finish, take as poll


def take(registry, node):
    commands = poll(registry, node)
    for command in commands:
        if command["type"] == "run.start":
            registry.handle_event(node["id"], {"type": "run.executing", **{key: command[key]
                for key in ("sessionId", "runId", "agent", "leaseId")}, "commandId": command["id"]}, "token_node_here")
    return commands


def task_workflow(client, project, payload, **patch):
    """A Project Task that names its own Project's Workflow, never a Team."""
    created = client.post("/api/v1/workflows", json={
        "name": "Ship by workflow", "projectId": project["id"],
        "workflowSteps": payload["workflowSteps"],
    })
    assert created.status_code == 201, created.text
    workflow = created.json()["workflow"]
    response = client.post("/api/v1/tasks", json={
        "title": "Ship by workflow", "projectId": project["id"],
        "assignedWorkflowId": workflow["id"], **patch,
    })
    assert response.status_code == 201, response.text
    return response.json(), workflow


def start_task(client, task):
    response = client.post(f"/api/v1/tasks/{task['id']}/runs", json={})
    assert response.status_code == 202, response.text
    assert response.json()["dispatch"]["state"] == "started", response.text
    return response.json()["session"]


def test_late_workflow_approval_starts_a_fresh_queue_grace(monkeypatch):
    with workflow_world(monkeypatch) as (app, client, node, _, project, payload):
        task, _ = task_workflow(client, project, payload)
        # Age the request without sleeping or aging the Computer heartbeat.
        requested_at = datetime.now(UTC) - timedelta(seconds=15)
        with monkeypatch.context() as clock:
            clock.setattr(run_requests, "now_iso", requested_at.isoformat)
            session = start_task(client, task)

        registry = app.state.registry
        first, = take(registry, node)
        finish(registry, node, first, {"Design": "design ready"})
        sid = session["id"]
        path = f"/api/v1/threads/{sid}"
        parked = client.get(path).json()
        assert parked["execution"]["blockingReason"] == "workflow_waiting_for_human"

        approval_started = datetime.now(UTC)
        response = client.post(f"{path}/workflow-decisions", json=decision(parked, "approve"))
        assert response.status_code == 200, response.text
        execution = response.json()["execution"]
        assert execution["phase"] == "queued"
        assert execution["computerOnline"] is True
        assert execution["queueWaitConfirmed"] is False
        queued_at = datetime.fromisoformat(execution["queuedAt"])
        assert approval_started - timedelta(milliseconds=1) <= queued_at <= datetime.now(UTC)
        assert client.get(path).json()["execution"] == execution
        summary = client.get("/api/v1/threads?view=summary").json()["sessions"]
        assert next(row["execution"] for row in summary if row["id"] == sid) == execution

        with monkeypatch.context() as clock:
            clock.setattr(app.state.execution_lifecycle, "clock", lambda: queued_at + timedelta(seconds=10))
            waiting = client.get(path).json()["execution"]
            assert waiting["queueWaitConfirmed"] is True
            assert waiting["queuedAt"] == execution["queuedAt"]

        second, = take(registry, node)
        assert second["id"] != first["id"]
        running = client.get(path).json()["execution"]
        assert running["phase"] == "running"
        assert running["queuedAt"] is None


def test_task_workflow_gate_retry_and_completion_keep_one_execution(monkeypatch):
    with workflow_world(monkeypatch) as (app, client, node, _, project, payload):
        read_session = app.state.session_store.get_session

        def guard_history(session_id):
            caller = currentframe().f_back
            assert caller.f_code.co_name not in {
                "admit_workflow_first_step", "_finalize_workflow_step", "_resume_workflow_admission",
            }, "Workflow state transitions must not read the Thread transcript"
            return read_session(session_id)

        monkeypatch.setattr(app.state.session_store, "get_session", guard_history)
        task, workflow = task_workflow(client, project, payload)
        session = start_task(client, task)
        sid = session["id"]
        registry = app.state.registry
        current_task = app.state.task_store.get_task(task["id"])
        owner = current_task["executionOwner"]
        assert owner["requestId"] == workflow_request_id(session["workflowRuns"][0])
        assert current_task["linkedSessionIds"] == [sid]
        command, = take(registry, node)
        finish(registry, node, command, {})
        session = app.state.session_store.get_session(sid)
        assert session["workflowRuns"][0]["status"] == "blocked"
        assert app.state.task_store.get_task(task["id"])["status"] == "blocked"
        # Starting the Task again cannot replace the parked workflow.
        again = client.post(f"/api/v1/tasks/{task['id']}/runs", json={})
        assert again.json()["dispatch"]["code"] == "task_execution_active"
        assert take(registry, node) == []
        url = f"/api/v1/threads/{sid}/workflow-decisions"
        response = client.post(url, json=decision(session, "retry"))
        assert response.status_code == 200, response.text
        retried, = take(registry, node)
        assert retried["assignmentId"] != command["assignmentId"]
        assert retried["workspaceScope"]["taskId"] == task["id"]
        finish(registry, node, retried, {"Design": "design artifact"})
        session = app.state.session_store.get_session(sid)
        waiting = app.state.task_store.get_task(task["id"])
        assert waiting["status"] == "waiting_for_human"
        assert waiting["waitingSessionId"] == sid
        assert waiting["executionOwner"] == owner
        assert take(registry, node) == []
        assert client.patch(f"/api/v1/workflows/{workflow['id']}", json={"workflowSteps": list(reversed(payload["workflowSteps"]))}).status_code == 200
        response = client.post(url, json=decision(session, "approve"))
        assert response.status_code == 200, response.text
        deploy, = take(registry, node)
        finish(registry, node, deploy, {"URL": "https://example.test"})
        done = app.state.task_store.get_task(task["id"])
        assert done["status"] == "review"  # human acceptance policy survives
        assert done["executionOwner"] == owner
        assert done["linkedSessionIds"] == [sid]
        session = app.state.session_store.get_session(sid)
        assert session["status"] == "completed"
        assert [r["status"] for r in session["workflowRuns"][0]["attemptResults"]] == ["blocked", "succeeded", "succeeded"]
        assert take(registry, node) == []


def _run_to_review(app, client, node, sid):
    registry = app.state.registry
    design, = take(registry, node)
    finish(registry, node, design, {"Design": "design ready"})
    session = app.state.session_store.get_session(sid)
    response = client.post(f"/api/v1/threads/{sid}/workflow-decisions", json=decision(session, "approve"))
    assert response.status_code == 200, response.text
    deploy, = take(registry, node)
    finish(registry, node, deploy, {"URL": "https://example.test"})


def test_a_task_started_again_continues_in_its_own_workflow_thread(monkeypatch):
    with workflow_world(monkeypatch) as (app, client, node, _, project, payload):
        task, _ = task_workflow(client, project, payload)
        sid = start_task(client, task)["id"]
        _run_to_review(app, client, node, sid)
        assert app.state.session_store.get_session(sid)["status"] == "completed"

        reopened = client.patch(f"/api/v1/tasks/{task['id']}", json={"status": "assigned"})
        assert reopened.status_code == 200, reopened.text
        again = start_task(client, task)

        # Same thread, a second frozen run, reopened for the work.
        assert again["id"] == sid
        session = app.state.session_store.get_session(sid)
        assert session["status"] == "running"
        first, second = session["workflowRuns"]
        assert first["status"] == "completed"
        assert session["activeWorkflowRunId"] == second["workflowRunId"] != first["workflowRunId"]
        assert app.state.task_store.get_task(task["id"])["linkedSessionIds"] == [sid]

        _run_to_review(app, client, node, sid)
        assert app.state.task_store.get_task(task["id"])["status"] == "review"
        assert [run["status"] for run in app.state.session_store.get_session(sid)["workflowRuns"]] == [
            "completed", "completed",
        ]


def test_a_deleted_workflow_thread_is_not_continued(monkeypatch):
    with workflow_world(monkeypatch) as (app, client, node, _, project, payload):
        task, _ = task_workflow(client, project, payload)
        sid = start_task(client, task)["id"]
        _run_to_review(app, client, node, sid)
        assert client.delete(f"/api/v1/threads/{sid}").status_code in (200, 202, 204)

        assert client.patch(f"/api/v1/tasks/{task['id']}", json={"status": "assigned"}).status_code == 200
        again = start_task(client, task)

        assert again["id"] != sid
        assert len(app.state.session_store.get_session(again["id"])["workflowRuns"]) == 1


@pytest.mark.parametrize("scope", ["standalone", "foreign"])
def test_workflow_task_assignment_requires_matching_project(monkeypatch, scope):
    with workflow_world(monkeypatch) as (app, client, _, _, project, payload):
        workflow = client.post("/api/v1/workflows", json={
            "name": "Scoped delivery", "projectId": project["id"],
            "workflowSteps": payload["workflowSteps"],
        }).json()["workflow"]
        body = {"title": "Invalid scope", "assignedWorkflowId": workflow["id"]}
        if scope == "foreign":
            from issue_projects import project_for_agents
            other = project_for_agents(app.state.project_store, project["ownerUserId"],
                                       [app.state.agent_store.get_agent(payload["leadAgentId"])], name="Other")
            body["projectId"] = other["id"]
        response = client.post("/api/v1/tasks", json=body)
        assert response.status_code in (400, 409), response.text
        assert "team_workflow_project" in response.text


@pytest.mark.parametrize("kind", ["reject", "cancel"])
def test_gated_first_task_has_claim_and_no_command(monkeypatch, kind):
    with workflow_world(monkeypatch) as (app, client, node, _, project, payload):
        payload["workflowSteps"][0]["requiresApproval"] = True
        task, _ = task_workflow(client, project, payload)
        session = start_task(client, task)
        assert take(app.state.registry, node) == []
        current = app.state.task_store.get_task(task["id"])
        assert current["status"] == "waiting_for_human"
        assert current.get("executionOwner")
        response = client.post(f"/api/v1/threads/{session['id']}/workflow-decisions", json=decision(session, kind))
        assert response.status_code == 200, response.text
        assert app.state.task_store.get_task(task["id"])["status"] == ("blocked" if kind == "reject" else "cancelled")


def test_stale_workflow_cannot_dispatch_after_task_generation_replaced(monkeypatch):
    with workflow_world(monkeypatch) as (app, client, node, _, project, payload):
        payload["workflowSteps"][0]["requiresApproval"] = True
        task, _ = task_workflow(client, project, payload)
        session = start_task(client, task)
        owner = app.state.task_store.get_task(task["id"])["executionOwner"]
        app.state.task_store.append_event(task["id"], relay_task_event("task.execution.claimed", task["id"], {
            "requestId": "replacement", "expectedRevision": owner["revision"],
        }))
        response = client.post(f"/api/v1/threads/{session['id']}/workflow-decisions", json=decision(session, "approve"))
        assert response.status_code == 409, response.text
        assert "task_ownership_changed" in response.text
        assert take(app.state.registry, node) == []
        assert app.state.task_store.get_task(task["id"])["executionOwner"]["requestId"] == "replacement"


def test_cancel_active_task_holds_reservation_until_exit(monkeypatch):
    with workflow_world(monkeypatch) as (app, client, node, _, project, payload):
        task, _ = task_workflow(client, project, payload)
        session = start_task(client, task)
        command, = take(app.state.registry, node)
        response = client.post(f"/api/v1/threads/{session['id']}/workflow-decisions", json=decision(session, "cancel"))
        assert response.status_code == 200, response.text
        assert app.state.task_store.get_task(task["id"])["status"] == "cancelled"
        assert len(app.state.daemon_store.list_active_runs(node["id"])) == 1
        finish(app.state.registry, node, command, {"Design": "late"})
        assert app.state.daemon_store.list_active_runs(node["id"]) == []
        assert app.state.task_store.get_task(task["id"])["status"] == "cancelled"
        assert not [c for c in take(app.state.registry, node) if c["type"] == "run.start"]


def test_reconcile_and_retry_task_keep_execution_generation(monkeypatch):
    with workflow_world(monkeypatch) as (app, client, node, _, project, payload):
        task, _ = task_workflow(client, project, payload)
        session = start_task(client, task)
        command, = take(app.state.registry, node)
        owner = app.state.task_store.get_task(task["id"])["executionOwner"]
        app.state.registry.handle_event(node["id"], {"type": "run.exit_unconfirmed",
            **{key: command[key] for key in ("sessionId", "runId", "agent", "leaseId")},
            "commandId": command["id"], "reason": "Exit unknown"}, "token_node_here")
        response = client.post(f"/api/v1/threads/{session['id']}/execution/reconcile")
        assert response.status_code == 200, response.text
        session = app.state.session_store.get_session(session["id"])
        assert app.state.task_store.get_task(task["id"])["status"] == "blocked"
        response = client.post(f"/api/v1/threads/{session['id']}/workflow-decisions", json=decision(session, "retry"))
        assert response.status_code == 200, response.text
        retried, = take(app.state.registry, node)
        assert retried["runId"] != command["runId"]
        assert app.state.task_store.get_task(task["id"])["executionOwner"] == owner


def test_publication_failure_rolls_back_task_link_generation_and_ledger(monkeypatch):
    with workflow_world(monkeypatch) as (app, client, node, _, project, payload):
        task, _ = task_workflow(client, project, payload)
        def refuse(*args, **kwargs):
            raise ValueError("publication interrupted")
        with monkeypatch.context() as patch:
            patch.setattr(app.state.daemon_store, "publish_command", refuse)
            response = client.post(f"/api/v1/tasks/{task['id']}/runs", json={})
            assert response.status_code == 202, response.text
            assert response.json()["dispatch"]["state"] == "rejected"
        current = app.state.task_store.get_task(task["id"])
        assert current["linkedSessionIds"] == []
        assert not current.get("executionOwner")
        assert not current.get("dispatchClaim")
        assert app.state.daemon_store.active_run_request_for_task(task["id"]) is None
        assert take(app.state.registry, node) == []
        # Explicit retry starts cleanly after the publication error is gone.
        session = start_task(client, task)
        assert len(take(app.state.registry, node)) == 1
        assert session["workflowRuns"][0]["currentIndex"] == 0


def test_task_runtime_failure_before_executing_blocks_workflow(monkeypatch):
    with workflow_world(monkeypatch) as (app, client, node, _, project, payload):
        task, _ = task_workflow(client, project, payload)
        session = start_task(client, task)
        command, = poll(app.state.registry, node)
        finish(app.state.registry, node, command, {}, type="run.failed", exitCode=1, error="Preflight failed")
        current = app.state.session_store.get_session(session["id"])
        assert current["workflowRuns"][0]["status"] == "blocked"
        assert app.state.task_store.get_task(task["id"])["status"] == "blocked"
        assert app.state.daemon_store.list_active_runs(node["id"]) == []


def test_disabled_saved_workflow_records_actionable_dispatch_blocker(monkeypatch):
    with workflow_world(monkeypatch) as (app, client, node, _, project, payload):
        task, workflow = task_workflow(client, project, payload)
        disabled = client.patch(f"/api/v1/workflows/{workflow['id']}", json={"enabled": False})
        assert disabled.status_code == 200, disabled.text
        response = client.post(f"/api/v1/tasks/{task['id']}/runs", json={})
        assert response.status_code == 202, response.text
        assert response.json()["dispatch"]["state"] == "rejected"
        assert response.json()["task"]["status"] == "blocked"
        assert "workflow_disabled" in response.json()["task"]["blockerReason"]
        assert take(app.state.registry, node) == []


def test_legacy_create_session_cannot_leave_orphan_workflow_task(monkeypatch):
    with workflow_world(monkeypatch) as (app, client, node, _, project, payload):
        team = client.post("/api/v1/teams", json=payload).json()["team"]
        before = app.state.task_store.list_tasks()
        response = client.post("/api/v1/tasks", json={"title": "Legacy session entry",
            "projectId": project["id"], "assignedTeamId": team["id"], "createSession": True})
        assert response.status_code == 400, response.text
        assert response.json()["detail"] == "project_team_assignment_forbidden"
        assert app.state.task_store.list_tasks() == before
        assert take(app.state.registry, node) == []
