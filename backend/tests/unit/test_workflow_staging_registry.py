"""Registry gate staging must stay separate from command admission."""
from copy import deepcopy
from uuid import uuid4

import pytest

from relay.daemon_registry.registry import DaemonNodeRegistry
from test_workflow_compilation import compile_run
from test_workflow_registry import runtime as registry_runtime


runtime = registry_runtime


def payload(runtime):
    return {**{k: v for k, v in runtime[3].items() if k in (
        "ownerUserId", "computerId", "projectId", "teamId", "workspacePath", "taskGoal",
        "workspaceLayout", "workspaceSubpath",
    )}, "id": str(uuid4())}


def test_stage_has_durable_request_without_commands(runtime):
    registry, sessions, daemons, _ = runtime
    body, assignments = payload(runtime), compile_run()
    session = registry.stage_workflow_gate(body, assignments)
    assert session["workflowRuns"][0]["assignments"] == assignments
    assert session["workflowRuns"][0]["status"] == "awaiting_approval"
    restarted = DaemonNodeRegistry(sessions, daemons)
    restarted.reap_stale_runs()
    assert "events" not in session
    assert sessions.get_session_header(session["id"]) == session
    assert len(daemons.list_active_run_requests()) == 1
    assert daemons.list_active_run_requests()[0]["status"] == "prepared"
    assert daemons.take_queued_commands("node") == []
    assert restarted.stage_workflow_gate(body, assignments) == session


@pytest.mark.parametrize("invalid", ["scope", "initial_attempt", "contract"])
def test_staging_refusal_cannot_leave_a_thread(runtime, invalid):
    registry, sessions, _, _ = runtime
    body, assignments = payload(runtime), compile_run()
    if invalid == "ungated":
        team = deepcopy(assignments[0]["teamSnapshot"])
        team["workflowSteps"][0]["requiresApproval"] = False
        assignments = compile_run(team=team)
    elif invalid == "scope":
        body["projectId"] = "other-project"
    elif invalid == "initial_attempt":
        from relay.collaboration.workflow_compilation import retry_workflow_assignment
        assignments[0] = retry_workflow_assignment(assignments[0])
    else:
        assignments[0]["brief"] = "Mutated instructions"
    with pytest.raises(ValueError):
        registry.stage_workflow_gate(body, assignments)
    with pytest.raises(KeyError):
        sessions.get_session(body["id"])
