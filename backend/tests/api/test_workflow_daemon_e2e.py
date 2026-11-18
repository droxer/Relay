"""Loopback backend + real daemon workflow delivery, with a deterministic runtime."""
import json
import time
from uuid import uuid4

import pytest

from daemon_e2e import DaemonE2E, eventually
from test_workflow_progression import decision


@pytest.fixture
def workflow_daemon(tmp_path, monkeypatch):
    h = DaemonE2E(tmp_path, monkeypatch, daemon_options={"commandPollWaitMs": 100})
    try:
        h.setup()
        h.stop_daemon()
        h.profile["workflow"] = True
        (h.root / "profile.json").write_text(json.dumps(h.profile))
        h.start_daemon()
        eventually(lambda: len([item for item in h.traces() if item["kind"] == "registered"]) == 2)
        yield h
    finally:
        h.close()


def workflow_fields(h):
    return {
        "name": "Ship in order", "projectId": h.project["id"],
        "workflowSteps": [
            {"id": name, "name": name, "agentId": h.agent["id"], "instructions": f"Do {name}",
             "expectedOutputs": [f"{name} report"], "acceptanceCriteria": ["Record evidence"],
             "requiresApproval": name == "deploy"}
            for name in ("design", "build", "verify", "deploy")
        ],
    }


def team(h):
    return h.post("/teams", {**workflow_fields(h), "leadAgentId": h.agent["id"],
                             "memberAgentIds": [h.agent["id"]]}, 201)["team"]


def start(h, workflow):
    return h.post(f"/teams/{workflow['id']}/workflow-runs", {
        "requestId": str(uuid4()), "taskGoal": "Exercise four workflow steps",
    }, 201)


def wait_for(h, sid, index, status):
    def check():
        session = h.session(sid)
        run = session["workflowRuns"][0]
        return session if run["currentIndex"] == index and run["status"] == status else None
    return eventually(check)


@pytest.mark.integration
@pytest.mark.parametrize("entry", ["project", "task", "independent"])
def test_daemon_workflow_failure_retry_gate_restart_and_frozen_definition(workflow_daemon, entry):
    h = workflow_daemon
    if entry == "independent":
        workflow = h.post("/workflows", workflow_fields(h), 201)["workflow"]
    elif entry == "task":
        workflow = h.post(
            "/workflows",
            {**workflow_fields(h), "projectId": h.project["id"]},
            201,
        )["workflow"]
    else:
        workflow = team(h)
    task = None
    if entry == "independent":
        assert h.ctx.team_store.list_teams() == []
        session = h.post(f"/workflows/{workflow['id']}/runs", {
            "requestId": str(uuid4()), "taskGoal": "Exercise independent steps",
        }, 201)
        assert not session.get("teamId")
    elif entry == "task":
        # A Project Task names its own Project Workflow, never a Team.
        task = h.post("/tasks", {"title": "Ship Task workflow", "projectId": h.project["id"],
                                  "assignedWorkflowId": workflow["id"]}, 201)
        result = h.post(f"/tasks/{task['id']}/runs", {}, 202)
        assert result["dispatch"]["state"] == "started", result
        session = result["session"]
    else:
        session = start(h, workflow)
    sid = session["id"]
    owner = h.ctx.task_store.get_task(task["id"])["executionOwner"] if task else None
    blocked = wait_for(h, sid, 2, "blocked")
    assert blocked["workflowRuns"][0]["attemptResults"][-1]["reason"] == "workflow_outputs_required"
    assert len([item for item in h.traces() if item["kind"] == "launch"]) == 3
    assert not h.ctx.daemon_store.list_active_runs(h.node_id)

    edit_path = f"/api/v1/workflows/{workflow['id']}" if entry in ("independent", "task") else f"/api/v1/teams/{workflow['id']}"
    edited = h.client.patch(edit_path, json={
        "workflowSteps": list(reversed(workflow["workflowSteps"])),
    })
    assert edited.status_code == 200, edited.text
    h.stop_server()
    restarted_at = time.time_ns() // 1_000_000
    h.restart_server()
    restored = h.session(sid)
    assert restored["workflowRuns"] == blocked["workflowRuns"]
    # A restored node is not dispatchable until it polls the new backend.
    # Do not mistake that expected recovery interval for an owner retry fault.
    eventually(lambda: any(item["kind"] == "connection-response"
                          and item.get("path", "").endswith("/commands")
                          and item.get("status") == 200 and item["at"] >= restarted_at
                          for item in h.traces()))
    url = f"/threads/{sid}/workflow-decisions"
    retry = decision(restored, "retry")
    h.post(url, retry, 200)
    gated = wait_for(h, sid, 3, "awaiting_approval")
    assert h.client.post("/api/v1" + url, json=retry).status_code == 409
    assert len([item for item in h.traces() if item["kind"] == "launch"]) == 4
    assert not h.ctx.daemon_store.list_active_runs(h.node_id)
    approve = decision(gated, "approve")
    h.post(url, approve, 200)
    completed = h.settled(sid, 5)
    assert h.client.post("/api/v1" + url, json=approve).status_code == 409
    run = completed["workflowRuns"][0]
    assert [item["workflowStepId"] for item in run["attemptResults"]] == ["design", "build", "verify", "verify", "deploy"]
    assert [item["workflowAttempt"] for item in run["attemptResults"]] == [1, 1, 1, 2, 1]
    assert [step["id"] for step in run["teamSnapshot"]["workflowSteps"]] == ["design", "build", "verify", "deploy"]
    launches = [item for item in h.traces() if item["kind"] == "launch"]
    assert "design report" in launches[1]["brief"]
    assert "verify report" in launches[-1]["brief"]
    assert not h.ctx.daemon_store.list_active_runs(h.node_id)
    if task:
        finished = h.ctx.task_store.get_task(task["id"])
        assert finished["status"] == "review"
        assert finished["executionOwner"] == owner
        assert finished["linkedSessionIds"] == [sid]


@pytest.mark.integration
def test_daemon_workflow_cancel_stops_current_runtime_without_successor(workflow_daemon):
    h = workflow_daemon
    workflow = team(h)
    (h.root / "hold").touch()
    session = start(h, workflow)
    sid = session["id"]
    eventually(lambda: any(item["kind"] == "launch" for item in h.traces()))
    assert h.ctx.daemon_store.list_active_runs(h.node_id)
    h.post(f"/threads/{sid}/workflow-decisions", decision(h.session(sid), "cancel"), 200)
    cancelled = h.settled(sid, 1, "cancelled")
    eventually(lambda: not h.ctx.daemon_store.list_active_runs(h.node_id))
    assert cancelled["workflowRuns"][0]["status"] == "cancelled"
    assert len([item for item in h.traces() if item["kind"] == "launch"]) == 1


@pytest.mark.integration
def test_daemon_completes_criteria_only_steps_with_evidence(workflow_daemon):
    h = workflow_daemon
    workflow = team(h)
    steps = [{key: value for key, value in step.items() if key != "expectedOutputs"}
             for step in workflow["workflowSteps"][:2]]
    response = h.client.patch(f"/api/v1/teams/{workflow['id']}", json={"workflowSteps": steps})
    assert response.status_code == 200, response.text
    session = start(h, response.json()["team"])
    completed = h.settled(session["id"], 2)
    results = completed["workflowRuns"][0]["attemptResults"]
    assert [item["status"] for item in results] == ["succeeded", "succeeded"]
    assert all(item["outputs"] == {} and item["evidence"] for item in results)
    launches = [item for item in h.traces() if item["kind"] == "launch"]
    assert all("Required output names:" not in item["brief"] for item in launches)
    assert all("Acceptance criteria:" in item["brief"] for item in launches)
    assert "Emitted eight deterministic replies." in launches[1]["brief"]
