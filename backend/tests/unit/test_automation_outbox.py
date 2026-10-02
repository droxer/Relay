from __future__ import annotations

from datetime import datetime, timedelta, timezone
from tempfile import TemporaryDirectory

from relay.persistence.automation_store import DatabaseAutomationStore
from relay.persistence.session_store import DatabaseSessionStore
from relay.persistence.store_common import relay_event
from relay.persistence.task_store import DatabaseTaskStore

NOW = datetime(2026, 10, 2, 12, tzinfo=timezone.utc)


def _stores(root: str):
    url = f"sqlite:///{root}/relay.db"
    return (DatabaseTaskStore(url, create_schema=True), DatabaseSessionStore(url, create_schema=True),
            DatabaseAutomationStore(url, create_schema=True))


def test_task_create_and_status_change_write_outbox_rows() -> None:
    with TemporaryDirectory() as root:
        tasks, _, automations = _stores(root)
        task = tasks.create_task({"title": "Import", "priority": "high"})
        tasks.update_task(task["id"], {"status": "blocked", "blockerReason": "stuck"})
        rows = automations.claim_outbox(10, NOW)
        assert [row["event_type"] for row in rows] == ["task.created", "task.status_changed"]
        assert rows[1]["payload"]["from"] == "backlog"
        assert rows[1]["payload"]["to"] == "blocked"
        assert rows[1]["payload"]["subject"]["title"] == "Import"


def test_routine_definitions_and_plain_edits_write_nothing() -> None:
    with TemporaryDirectory() as root:
        tasks, _, automations = _stores(root)
        routine = tasks.create_task({"title": "Weekly", "isRoutine": True, "routineEnabled": False})
        tasks.update_task(routine["id"], {"title": "Weekly report"})
        assert automations.claim_outbox(10, NOW) == []


def test_occurrence_status_change_carries_loop_provenance() -> None:
    with TemporaryDirectory() as root:
        tasks, _, automations = _stores(root)
        occurrence = tasks.create_task({"title": "Run", "sourceRoutineId": "R-1", "routineTriggerDepth": 1})
        assert automations.claim_outbox(10, NOW) == []
        tasks.update_task(occurrence["id"], {"status": "blocked", "blockerReason": "x"})
        [row] = automations.claim_outbox(10, NOW)
        assert row["origin_automation_id"] == "R-1"
        assert row["depth"] == 2


def test_run_completion_writes_run_rows_but_not_cancellation() -> None:
    with TemporaryDirectory() as root:
        _, sessions, automations = _stores(root)
        session = sessions.create_session({"workspacePath": "/w", "taskGoal": "g", "participants": ["human"]})
        for status in ("completed", "failed", "cancelled"):
            sessions.append_event(session["id"], relay_event("agent.completed", session["id"], {
                "runId": f"run_{status}", "agent": "codex", "status": status, "exitCode": 0}))
        rows = automations.claim_outbox(10, NOW)
        assert [row["event_type"] for row in rows] == ["run.completed", "run.failed"]


def test_claims_are_exclusive_until_stale() -> None:
    with TemporaryDirectory() as root:
        tasks, _, automations = _stores(root)
        tasks.create_task({"title": "Import"})
        assert len(automations.claim_outbox(10, NOW)) == 1
        assert automations.claim_outbox(10, NOW + timedelta(minutes=1)) == []
        reclaimed = automations.claim_outbox(10, NOW + timedelta(minutes=6))
        assert len(reclaimed) == 1
        automations.delete_outbox([reclaimed[0]["id"]])
        assert automations.claim_outbox(10, NOW + timedelta(hours=1)) == []


def test_webhook_secret_is_hashed_and_rotates() -> None:
    with TemporaryDirectory() as root:
        _, _, automations = _stores(root)
        first = automations.set_webhook_secret("R-1")
        assert automations.verify_webhook_secret("R-1", first)
        second = automations.set_webhook_secret("R-1")
        assert not automations.verify_webhook_secret("R-1", first)
        assert automations.verify_webhook_secret("R-1", second)
        assert not automations.verify_webhook_secret("R-2", second)
        automations.delete_webhook_secret("R-1")
        assert not automations.has_webhook_secret("R-1")


def test_state_round_trips_and_lists_pending() -> None:
    with TemporaryDirectory() as root:
        _, _, automations = _stores(root)
        assert automations.get_state("R-1")["pending"] is False
        automations.save_state("R-1", {**automations.get_state("R-1"), "pending": True,
                                       "pending_events": [{"eventType": "webhook"}], "pending_since": NOW})
        [state] = automations.list_pending_states()
        assert state["routine_id"] == "R-1"
        automations.clear_state("R-1")
        assert automations.list_pending_states() == []
