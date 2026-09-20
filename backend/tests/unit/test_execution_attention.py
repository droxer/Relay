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
