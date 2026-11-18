"""Unsupported workflow requests must not escape through legacy registry delivery."""
from copy import deepcopy

import pytest
from loguru import logger

from relay.daemon_registry.dispatch.workflow_admission import workflow_request_id, workflow_request_state
from relay.daemon_registry.registry import DaemonNodeRegistry
from relay.daemon_registry.runs import workflow
from relay.persistence.events import relay_event
from store_fixtures import make_daemon_store, make_session_store
from test_workflow_compilation import compile_run


@pytest.fixture
def runtime(tmp_path):
    sessions = make_session_store(tmp_path)
    daemons = make_daemon_store(tmp_path)
    registry = DaemonNodeRegistry(sessions, daemons)
    registry.register({
        "sandboxId": "node", "userId": "owner", "token": "test-node-token",
        "workspacePath": str(tmp_path), "protocolVersion": 1,
        "supportedAgents": ["codex", "claude"],
        "capabilities": ["workspace-scope", "thread-workspaces"], "status": "ready",
    }, "test-ui-token")
    session = sessions.create_session({
        "workspacePath": str(tmp_path), "taskGoal": "Workflow",
        "ownerUserId": "owner", "projectId": "project-1",
        "teamId": "team-1", "computerId": "computer-1",
    })
    return registry, sessions, daemons, session


def assert_no_delivery(runtime):
    registry, sessions, daemons, session = runtime
    assert daemons.take_queued_commands("node") == []
    assert sessions.get_session(session["id"])["agentRuns"] == []
    assert registry.active_commands == {}


@pytest.mark.parametrize("entry", ["prepare_run_request", "start_run_request"])
@pytest.mark.parametrize("marker", [
    "full", "run", "step", "attempt", "kind", "snapshot", "manifest", "policy", "manifest_turn",
])
def test_new_workflow_request_refused_before_persistence(runtime, entry, marker):
    registry, sessions, daemons, session = runtime
    assignments, state = compile_run(), {}
    if marker != "full":
        fields = {
            "run": {"workflowRunId": "run-1"}, "step": {"workflowStepId": "review"},
            "attempt": {"workflowAttempt": 1}, "kind": {"workKind": "workflow_step"},
            "snapshot": {"teamSnapshot": {"workflowSteps": []}},
            "manifest": {}, "policy": {}, "manifest_turn": {},
        }
        assignments = [{"executorKind": "codex", "mode": "action", **fields[marker]}]
        if marker == "manifest":
            state = {"_relay_collaboration_manifest": {
                "teamSnapshot": {"projectId": "project-1"},
            }}
        if marker == "policy":
            state = {"_relay_collaboration_manifest": {
                "workGraph": {"delegationPolicy": {"policy": "project-workflow-v1"}},
            }}
        if marker == "manifest_turn":
            state = {"_relay_collaboration_manifest": {"assignments": [{"workflowAttempt": 1}]}}
    before = sessions.get_session(session["id"])
    with pytest.raises(ValueError, match="team_workflow_execution_unavailable"):
        getattr(registry, entry)("node", session["id"], "Workflow", assignments, state)
    assert daemons.active_run_request_for_session_any_node(session["id"]) is None
    assert sessions.get_session(session["id"]) == before
    assert_no_delivery(runtime)


@pytest.mark.parametrize("status", ["prepared", "running"])
@pytest.mark.parametrize("approved", [False, True])
def test_activation_cannot_use_legacy_index_approval_to_run_workflow(runtime, status, approved):
    registry, sessions, daemons, session = runtime
    assignments = compile_run()
    sessions.append_event(session["id"], relay_event("workflow.started", session["id"], {
        "assignments": assignments,
    }))
    request = daemons.create_run_request({
        "nodeId": "node", "sessionId": session["id"], "taskGoal": "Workflow",
        "assignments": assignments, "status": status,
        "state": {"_relay_approved_index": 0} if approved else {},
    })
    before = deepcopy(request)
    with pytest.raises(ValueError, match="team_workflow_execution_unavailable"):
        registry.activate_run_request(request["id"])
    assert daemons.get_run_request(request["id"]) == before
    assert_no_delivery(runtime)


@pytest.mark.parametrize("linked", [False, True])
def test_restart_cannot_publish_previously_staged_workflow(runtime, linked):
    registry, sessions, daemons, session = runtime
    request = daemons.create_run_request({
        "nodeId": "node", "sessionId": session["id"], "taskGoal": "Workflow",
        "assignments": compile_run(), "status": "running", "state": {},
    })
    claim = daemons.claim_run_request_dispatch(request["id"], "test-claim", -1)
    command = {
        "id": "test-command", "type": "run.start", "sessionId": session["id"],
        "runId": "test-run", "agent": "claude", "executorKind": "claude",
        "taskGoal": "Workflow", "_nodeId": "node", "_runRequestId": request["id"],
        "_dispatchClaimId": "test-claim", "state": {},
    }
    assert claim is not None
    assert daemons.stage_command("node", command, request_id=request["id"], claim_id="test-claim")
    if linked:
        daemons.update_run_request(request["id"], {
            "currentCommandId": command["id"], "currentRunId": command["runId"],
        })
    restarted = DaemonNodeRegistry(sessions, daemons)
    current = daemons.get_run_request(request["id"])
    with pytest.raises(ValueError, match="team_workflow_execution_unavailable"):
        if linked:
            restarted._recover_linked_request(current, command["id"])
        else:
            restarted._redeliver_staged_command(current, daemons.get_command(command["id"]))
    restarted.reap_stale_runs()
    assert daemons.get_command(command["id"])["status"] == "pending"
    assert sessions.get_session(session["id"])["agentRuns"] == []
    assert daemons.take_queued_commands("node") == []


def test_direct_successor_delivery_cannot_escape_activation_guard(runtime):
    registry, _, daemons, session = runtime
    request = daemons.create_run_request({
        "nodeId": "node", "sessionId": session["id"], "taskGoal": "Workflow",
        "assignments": compile_run(), "status": "running", "currentIndex": 1, "state": {},
    })
    with pytest.raises(ValueError, match="team_workflow_execution_unavailable"):
        registry._enqueue_current_assignment(request)
    assert daemons.get_run_request(request["id"]) == request
    assert_no_delivery(runtime)


def test_legacy_direct_registry_delivery_still_works(runtime):
    registry, _, daemons, session = runtime
    request = registry.start_run_request("node", session["id"], "Legacy", [
        {"executorKind": "codex", "mode": "action"},
    ], {})
    assert request["currentCommandId"]
    assert len(daemons.take_queued_commands("node")) == 1


def test_existing_request_cannot_be_reprepared_with_stripped_markers(runtime):
    registry, _, daemons, session = runtime
    request = daemons.create_run_request({
        "nodeId": "node", "sessionId": session["id"], "taskGoal": "Workflow",
        "assignments": compile_run(), "status": "prepared", "state": {},
    })
    with pytest.raises(ValueError, match="team_workflow_execution_unavailable"):
        registry.prepare_run_request("node", session["id"], "Legacy", [
            {"executorKind": "codex", "mode": "action"},
        ], {}, request_id=request["id"])
    assert daemons.get_run_request(request["id"]) == request
    assert_no_delivery(runtime)


def test_recovery_keeps_delivered_reservation_and_can_still_request_stop(runtime):
    registry, sessions, daemons, session = runtime
    request = registry.start_run_request("node", session["id"], "Legacy", [
        {"executorKind": "codex", "mode": "action"},
    ], {})
    delivered = daemons.take_queued_commands("node")
    assert len(delivered) == 1
    daemons.update_run_request(request["id"], {"assignments": compile_run()})
    restarted = DaemonNodeRegistry(sessions, daemons)
    restarted.reap_stale_runs()
    active = daemons.active_run_request_for_session_any_node(session["id"])
    assert active["id"] == request["id"]
    assert daemons.get_command(request["currentCommandId"])["status"] == "dispatched"
    restarted.cancel_active_run("node", session["id"], "Owner stopped", actor_user_id="owner")
    assert daemons.active_run_request_for_session_any_node(session["id"])["id"] == request["id"]
    stops = daemons.take_queued_commands("node")
    assert len(stops) == 1
    assert stops[0]["command"]["type"] == "run.cancel"


def test_prepared_workflow_recovery_settles_session_deleted_after_admission_error(runtime, monkeypatch):
    registry, sessions, daemons, session = runtime
    sid = session["id"]
    session = sessions.append_event(sid, relay_event("workflow.started", sid, {
        "assignments": compile_run(),
    }))
    run = session["workflowRuns"][0]
    request = daemons.create_run_request({
        "id": workflow_request_id(run), "nodeId": "node", "sessionId": sid,
        "taskGoal": "Workflow", "assignments": run["assignments"], "status": "prepared",
        "state": workflow_request_state(run, {}),
    })

    get_header = sessions.get_session_header
    resource_transaction = workflow.resource_transaction

    def read_header_before_closure(session_id):
        header = get_header(session_id)
        sessions.append_event(sid, relay_event("session.status", sid, {
            "status": "cancelled", "phase": "cancelled",
        }))
        return header

    def delete_before_recording_admission_error(engine, key):
        sessions.delete_session(sid)
        return resource_transaction(engine, key)

    monkeypatch.setattr(sessions, "get_session_header", read_header_before_closure)
    monkeypatch.setattr(workflow, "resource_transaction", delete_before_recording_admission_error)
    records = []
    sink = logger.add(lambda message: records.append(message.record), level="INFO")
    try:
        registry._recover_run_request(request)
    finally:
        logger.remove(sink)

    assert not any(record["message"] == "Run recovery failed" for record in records)
    settled = daemons.get_run_request(request["id"])
    assert settled["status"] == "failed"
    assert settled["error"] == "Prepared collaboration session no longer exists."
    recovery_log, = [record for record in records if record["extra"].get("request_id") == request["id"]]
    assert recovery_log["level"].name == "INFO"
    assert recovery_log["message"] == settled["error"]
    assert recovery_log["extra"]["session_id"] == sid
    assert recovery_log["exception"] is None
