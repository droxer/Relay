"""Durable workflow gates: real store transactions, restart and event replay."""
from copy import deepcopy
from concurrent.futures import ThreadPoolExecutor

import pytest

from relay.persistence.events import relay_event
from relay.persistence.session.reducer import apply_session_event, materialize_events
from store_fixtures import make_session_store
from test_workflow_compilation import compile_run
from relay.collaboration.workflow_compilation import retry_workflow_assignment


@pytest.fixture
def workflow(tmp_path):
    store = make_session_store(tmp_path)
    session = store.create_session({
        "workspacePath": str(tmp_path), "taskGoal": "Workflow",
        "ownerUserId": "owner", "projectId": "project-1",
        "teamId": "team-1", "computerId": "computer-1",
    })
    assignments = compile_run()
    start = relay_event("workflow.started", session["id"], {"assignments": assignments})
    return store, session["id"], start


def gate(session_id, start, **changes):
    first = start["assignments"][0]
    return relay_event("workflow.gate_decided", session_id, {
        "workflowRunId": first["workflowRunId"],
        "workflowStepId": first["workflowStepId"],
        "assignmentId": first["assignmentId"], "workflowAttempt": 1,
        "expectedRevision": 0, "actorUserId": "owner", "kind": "approve",
        **changes,
    })


def test_first_step_gate_survives_store_restart_and_replay(workflow, tmp_path):
    store, sid, start = workflow
    session = store.append_event(sid, start)
    run = session["workflowRuns"][0]
    assert run["status"] == "awaiting_approval"
    assert run["currentIndex"] == 0
    assert run["revision"] == 0
    assert [a["agentId"] for a in run["assignments"]] == ["reviewer", "builder", "reviewer"]
    assert run["teamSnapshot"] == start["assignments"][0]["teamSnapshot"]
    restored = make_session_store(tmp_path).get_session(sid)
    assert restored["workflowRuns"] == session["workflowRuns"]
    assert materialize_events(restored["events"])["workflowRuns"] == session["workflowRuns"]


def test_gate_decision_is_bound_and_audited(workflow):
    store, sid, start = workflow
    store.append_event(sid, start)
    decision = gate(sid, start)
    session = store.append_event(sid, decision)
    run = session["workflowRuns"][0]
    assert run["status"] == "ready"
    assert run["revision"] == 1
    assert run["gateDecisions"] == [decision]
    assert materialize_events(session["events"])["workflowRuns"] == session["workflowRuns"]
    assert session["agentRuns"] == []  # A gate event never creates execution.


@pytest.mark.parametrize("changes", [
    {"workflowRunId": "other"}, {"workflowStepId": "deploy"},
    {"workflowAttempt": 2}, {"workflowAttempt": True},
    {"assignmentId": "other"}, {"expectedRevision": 1},
    {"expectedRevision": False}, {"actorUserId": "admin"},
    {"actorUserId": ""}, {"kind": "mark_done"}, {"kind": "retry"},
])
def test_invalid_decision_rolls_back_event_and_snapshot(workflow, changes):
    store, sid, start = workflow
    before = store.append_event(sid, start)
    with pytest.raises(ValueError, match="workflow_"):
        store.append_event(sid, gate(sid, start, **changes))
    assert store.get_session(sid) == before


@pytest.mark.parametrize("kind", ["approve", "reject"])
def test_duplicate_decision_and_conflicting_replay_cannot_reopen_gate(workflow, kind):
    store, sid, start = workflow
    store.append_event(sid, start)
    decision = gate(sid, start, kind=kind)
    before = store.append_event(sid, decision)
    assert before["workflowRuns"][0]["status"] == ("ready" if kind == "approve" else "blocked")
    for repeated in (decision, gate(sid, start), gate(sid, start, expectedRevision=1)):
        with pytest.raises(ValueError, match="workflow_"):
            store.append_event(sid, repeated)
    assert store.get_session(sid) == before


def test_two_store_instances_racing_decisions_have_one_winner(workflow, tmp_path):
    store, sid, start = workflow
    store.append_event(sid, start)
    other = make_session_store(tmp_path)

    def decide(pair):
        target, kind = pair
        try:
            target.append_event(sid, gate(sid, start, kind=kind))
            return True
        except ValueError:
            return False

    with ThreadPoolExecutor(max_workers=2) as pool:
        assert sorted(pool.map(decide, [(store, "approve"), (other, "reject")])) == [False, True]
    session = store.get_session(sid)
    assert len(session["workflowRuns"][0]["gateDecisions"]) == 1
    assert sum(e["type"] == "workflow.gate_decided" for e in session["events"]) == 1


@pytest.mark.parametrize("field", ["projectId", "computerId", "ownerUserId", "id"])
def test_start_rejects_foreign_snapshot(workflow, field):
    store, sid, start = workflow
    for assignment in start["assignments"]:
        assignment["teamSnapshot"][field] = "other"
    before = store.get_session(sid)
    with pytest.raises(ValueError, match="workflow_"):
        store.append_event(sid, start)
    assert store.get_session(sid) == before


def test_second_start_does_not_replace_waiting_workflow(workflow):
    store, sid, start = workflow
    before = store.append_event(sid, start)
    for event in (start, relay_event("workflow.started", sid, {"assignments": compile_run(run_id="new-run")})):
        with pytest.raises(ValueError, match="workflow_"):
            store.append_event(sid, event)
    assert store.get_session(sid) == before


def test_reducer_never_mutates_source_snapshot_or_event(workflow):
    store, sid, start = workflow
    session = store.append_event(sid, start)
    before = deepcopy(session)
    decision = gate(sid, start)
    event_before = deepcopy(decision)
    reduced = apply_session_event(dict(session), decision, retain_event=False)
    reduced["workflowRuns"][0]["assignments"][0]["expectedOutputs"].append("changed")
    reduced["workflowRuns"][0]["gateDecisions"][0]["kind"] = "changed"
    assert session == before
    assert decision == event_before


def test_ungated_first_step_never_accepts_gate_decision(workflow):
    store, sid, start = workflow
    team = deepcopy(start["assignments"][0]["teamSnapshot"])
    team["workflowSteps"][0]["requiresApproval"] = False
    start["assignments"] = compile_run(team=team)
    session = store.append_event(sid, start)
    assert session["workflowRuns"][0]["status"] == "ready"
    with pytest.raises(ValueError, match="workflow_"):
        store.append_event(sid, gate(sid, start))


@pytest.mark.parametrize("assignments", [None, [], [None], [{}]])
def test_malformed_start_has_no_durable_effect(workflow, assignments):
    store, sid, start = workflow
    before = store.get_session(sid)
    with pytest.raises(ValueError, match="workflow_"):
        store.append_event(sid, {**start, "assignments": assignments})
    assert store.get_session(sid) == before


def test_start_cannot_smuggle_prior_attempt_or_reorder_steps(workflow):
    store, sid, start = workflow
    before = store.get_session(sid)
    for assignments in (
        [retry_workflow_assignment(start["assignments"][0]), *start["assignments"][1:]],
        list(reversed(start["assignments"])),
    ):
        with pytest.raises(ValueError, match="workflow_"):
            store.append_event(sid, {**start, "assignments": assignments})
    assert store.get_session(sid) == before


@pytest.mark.parametrize("phase", ["start", "gate"])
@pytest.mark.parametrize("status", ["completed", "failed", "cancelled"])
def test_terminal_session_cannot_be_reopened_by_workflow_event(workflow, phase, status):
    store, sid, start = workflow
    if phase == "gate":
        store.append_event(sid, start)
    before = store.append_event(sid, relay_event("session.status", sid, {"status": status, "phase": status}))
    with pytest.raises(ValueError, match="workflow_session_closed"):
        store.append_event(sid, start if phase == "start" else gate(sid, start))
    assert store.get_session(sid) == before


def test_wrong_session_event_and_gate_before_start_are_refused(workflow):
    store, sid, start = workflow
    before = store.get_session(sid)
    for event in ({**start, "sessionId": "other"}, gate(sid, start)):
        with pytest.raises(ValueError, match="workflow_"):
            store.append_event(sid, event)
    assert store.get_session(sid) == before


def test_start_snapshot_is_detached_and_not_affected_by_later_definition_edits(workflow):
    store, sid, start = workflow
    session = store.get_session(sid)
    original = deepcopy(start)
    projected = apply_session_event(dict(session), start, retain_event=False)
    start["assignments"][0]["teamSnapshot"]["workflowSteps"].reverse()
    assert projected["workflowRuns"][0]["teamSnapshot"] == original["assignments"][0]["teamSnapshot"]
    assert projected["workflowRuns"][0]["assignments"] == original["assignments"]
    assert "workflowRuns" not in session
