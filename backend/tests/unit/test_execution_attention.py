"""Blocked explanations survive replay and remain tied to their execution."""
import pytest
from relay.persistence.task_lifecycle import apply_flow_status
from relay.services.execution_lifecycle import execution_status
from relay.services.dispatch_failure import record_dispatch_failure
from relay.persistence.task_store import LocalTaskStore, DatabaseTaskStore


def test_missing_reason_is_explicit_unknown_without_borrowing_previous_cause():
    task = {"status": "blocked", "blockerReason": "Old execution failed", "workflowStage": "running"}
    apply_flow_status(task, {"status": "blocked", "timestamp": "now"})
    assert task["attention"]["code"] == "unknown"
    assert task["attention"]["evidence"] == "unknown"
    assert task["blockerReason"] != "Old execution failed"


def test_recorded_cause_and_link_survive_replay_then_clear():
    task = {"status": "running"}
    event = {"status": "blocked", "timestamp": "now", "reason": "Executor exited", "attention": {
        "code": "agent_exit_failed", "source": "execution", "sessionId": "actual", "runRequestId": "request",
    }}
    apply_flow_status(task, event)
    assert task["attention"]["sessionId"] == "actual"
    assert task["attention"]["summary"] == "Executor exited"
    assert task["attention"]["evidence"] == "recorded"
    apply_flow_status(task, {"status": "assigned", "timestamp": "later"})
    assert "attention" not in task


@pytest.mark.parametrize("database", [False, True])
def test_dispatch_cause_is_in_authoritative_blocked_event(tmp_path, database):
    store = DatabaseTaskStore(f"sqlite:///{tmp_path}/tasks.db", create_schema=True) if database else LocalTaskStore(tmp_path)
    task = store.create_task({"title": "Explain failure"})
    record_dispatch_failure(store, task, code="capacity_exhausted", message="Computer is full")
    result = store.get_task(task["id"])
    assert result["attention"]["code"] == "capacity_exhausted"
    assert result["attention"]["source"] == "dispatch"
    event = next(e for e in result["events"] if e["type"] == "task.status" and e["status"] == "blocked")
    assert event["attention"]["code"] == "capacity_exhausted"


def test_capabilities_do_not_allow_discarding_saved_terminal_evidence():
    status = execution_status({}, {"status": "finalizing", "state": {"_relay_recovery_required": True, "_relay_terminal_claim_id": "claim"}}, {"status": "completed"})
    assert status["canReportGone"] is False
    assert status["canRetrySave"] is True
    assert execution_status({}, None, None)["canReportGone"] is False
    orphan = execution_status({"agentRuns": [{"status": "running"}]}, None, None)
    assert orphan["canReportGone"] is True


@pytest.mark.parametrize("metadata", [None, [], {"code": 7, "source": "arbitrary", "sessionId": 7}])
def test_legacy_malformed_metadata_does_not_prevent_event_replay(metadata):
    task = {"status": "running"}
    apply_flow_status(task, {"status": "blocked", "timestamp": "now", "attention": metadata})
    assert task["attention"]["code"] == "unknown"
    assert task["attention"]["source"] == "legacy"
    assert "sessionId" not in task["attention"]


@pytest.mark.parametrize("database", [False, True])
def test_session_failure_records_source_in_detail_summary_and_replay(tmp_path, database):
    from relay.persistence.session_store import LocalSessionStore, DatabaseSessionStore
    from relay.sessions.controller import SessionController
    url = f"sqlite:///{tmp_path}/state.db"
    tasks = DatabaseTaskStore(url, create_schema=True) if database else LocalTaskStore(tmp_path)
    sessions = DatabaseSessionStore(url, create_schema=True) if database else LocalSessionStore(tmp_path)
    task = tasks.create_task({"title": "Failure context"})
    session = sessions.create_session({"taskGoal": "Fail with context", "workspacePath": "/workspace"})
    controller = SessionController(sessions, task_store=tasks, task_id=task["id"])
    controller.fail_session(session["id"], "Preflight refused credentials")
    current = tasks.get_task(task["id"])
    assert current["attention"]["sessionId"] == session["id"]
    assert current["attention"]["code"] == "execution_failed"
    assert current["attention"]["summary"] == "Preflight refused credentials"
    summary = tasks.list_task_summaries()[0]
    assert summary["attention"] == current["attention"]
    # Independently replay the authoritative status event.
    blocked = next(e for e in current["events"] if e["type"] == "task.status" and e["status"] == "blocked")
    replayed = {"status": "running"}
    apply_flow_status(replayed, blocked)
    assert replayed["attention"] == current["attention"]


def test_unknown_finalization_reason_still_preserves_terminal_claim():
    status = execution_status({}, {"status": "finalizing", "state": {
        "_relay_recovery_required": True, "_relay_recovery_reason": "future_save_error",
        "_relay_terminal_claim_id": "claim",
    }}, None)
    assert status["canRetrySave"] is True
    assert status["canReportGone"] is False
