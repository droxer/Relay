"""Trigger delivery across edits, resume, expiry, and delayed outbox drains."""

from datetime import UTC, datetime, timedelta

import pytest

from relay.automations.service import AutomationService, routine_fields_v2
from relay.persistence.automation.store import DatabaseAutomationStore
from relay.persistence.events import relay_event
from relay.persistence.session.store import DatabaseSessionStore
from relay.persistence.task.store import DatabaseTaskStore


@pytest.fixture
def world(tmp_path):
    url = f"sqlite:///{tmp_path}/relay.db"
    tasks = DatabaseTaskStore(url, create_schema=True)
    sessions = DatabaseSessionStore(url, create_schema=True)
    automations = DatabaseAutomationStore(url, create_schema=True)
    service = AutomationService(task_store=tasks, session_store=sessions,
                                automation_store=automations, project_store=None)
    return tasks, sessions, automations, service


def schedule(repeat):
    return {"kind": "schedule", "schedule": {"timezone": "UTC", "repeat": repeat}}


def routine(tasks, triggers, **extra):
    return tasks.create_task({"title": "Automation", "isRoutine": True,
                              "routineState": "active", "routineTriggers": triggers,
                              "assignedAgent": "codex", "ownerUserId": "alice", **extra})


def occurrences(tasks, task):
    return [tasks.get_task(item) for item in tasks.get_task(task["id"]).get("occurrenceIds", [])]


@pytest.mark.parametrize("repeat", [{"once": "2026-10-13T09:00"}, {"every": "day", "at": "09:00"}])
def test_ordinary_form_save_keeps_unprocessed_due_slot(world, repeat):
    tasks, _, _, service = world
    trigger = schedule(repeat)
    task = routine(tasks, [trigger], routineNextRunAt="2026-10-13T09:00:00+00:00")
    now = datetime(2026, 10, 13, 9, 0, 2, tzinfo=UTC)
    fields = routine_fields_v2({"routineTriggers": [trigger], "routineState": "active"}, current=task, now=now)
    tasks.update_task(task["id"], {"title": "Renamed", **fields})
    assert service.tick(now) == 1
    assert len(occurrences(tasks, task)) == 1


def test_schedule_change_recomputes_next_slot(world):
    tasks, _, _, _ = world
    task = routine(tasks, [schedule({"every": "day", "at": "09:00"})],
                   routineNextRunAt="2026-10-13T09:00:00+00:00")
    fields = routine_fields_v2({"routineTriggers": [schedule({"every": "day", "at": "11:00"})]},
                               current=task, now=datetime(2026, 10, 13, 10, tzinfo=UTC))
    assert fields["routineNextRunAt"] == "2026-10-13T11:00:00+00:00"


@pytest.mark.parametrize("kind", ["webhook", "task_event"])
def test_resume_ignores_undrained_events_but_keeps_other_recipients(world, kind):
    tasks, _, automations, service = world
    trigger = {"kind": "webhook"} if kind == "webhook" else {"kind": "task_event", "on": "created"}
    task = routine(tasks, [trigger])
    other = routine(tasks, [trigger])
    if kind == "webhook":
        automations.enqueue_webhook(task["id"], {"old": True})
    else:
        tasks.create_task({"title": "Before resume", "ownerUserId": "alice"})
    tasks.update_task(task["id"], {"routineState": "paused"})
    service.resume(task["id"], {"userId": "alice", "isAdmin": False}, datetime.now(UTC))
    assert service.tick(datetime.now(UTC)) == (1 if kind == "task_event" else 0)
    assert occurrences(tasks, task) == []
    if kind == "task_event":
        assert len(occurrences(tasks, other)) == 1
    if kind == "webhook":
        automations.enqueue_webhook(task["id"], {"fresh": True})
    else:
        tasks.create_task({"title": "After resume", "ownerUserId": "alice"})
    assert service.tick(datetime.now(UTC)) == 1
    assert len(occurrences(tasks, task)) == 1


@pytest.mark.parametrize("replacement", [[], [{"kind": "webhook"}], [schedule({"every": "day", "at": "11:00"})]])
def test_pending_schedule_is_invalidated_when_its_trigger_changes(world, replacement):
    tasks, _, automations, service = world
    now = datetime(2026, 10, 13, 9, 0, 2, tzinfo=UTC)
    task = routine(tasks, [schedule({"every": "day", "at": "09:00"})],
                   routineNextRunAt="2026-10-13T09:00:00+00:00")
    # Queue a real clock event behind an in-flight occurrence.
    active = tasks.create_triggered_occurrence(task["id"], run_date="2026-10-13",
                                               trigger_kind="manual", depth=0, context="")
    assert service.tick(now) == 0
    assert automations.get_state(task["id"])["pending"]
    task = tasks.get_task(task["id"])
    tasks.update_task(task["id"], routine_fields_v2({"routineTriggers": replacement}, current=task, now=now))
    tasks.update_task(active["id"], {"status": "done"})
    assert service.tick(now) == 0
    assert len(occurrences(tasks, task)) == 1


def test_pending_schedule_survives_adding_an_unrelated_trigger(world):
    tasks, _, _, service = world
    now = datetime(2026, 10, 13, 9, 0, 2, tzinfo=UTC)
    trigger = schedule({"every": "day", "at": "09:00"})
    task = routine(tasks, [trigger], routineNextRunAt="2026-10-13T09:00:00+00:00")
    service.clock.run(now)
    tasks.update_task(task["id"], {"routineTriggers": [trigger, {"kind": "webhook"}]})
    assert service.tick(now) == 1


@pytest.mark.parametrize("fresh_kind", ["webhook", "schedule", "manual"])
def test_expired_pending_batch_does_not_discard_a_fresh_trigger(world, fresh_kind):
    tasks, _, automations, service = world
    now = datetime.now(UTC)
    triggers = [schedule({"every": "hour", "minute": 0})] if fresh_kind == "schedule" else [{"kind": "webhook"}]
    task = routine(tasks, triggers, **({"routineNextRunAt": now.isoformat()} if fresh_kind == "schedule" else {}))
    automations.mark_pending(task["id"], {"eventType": "webhook", "payload": {"old": True}, "depth": 0},
                             now - timedelta(hours=25))
    if fresh_kind == "webhook":
        automations.enqueue_webhook(task["id"], {"fresh": True})
    elif fresh_kind == "manual":
        automations.enqueue_manual(task["id"])
    assert service.tick(now) == 1
    [occurrence] = occurrences(tasks, task)
    assert '"old": true' not in occurrence["description"]
    assert any("dropped 1 pending events" in event.get("message", "")
               for event in tasks.get_task(task["id"])["activity"])


@pytest.mark.parametrize("before,after,expected", [("high", "low", 1), ("low", "high", 0)])
def test_run_event_filters_use_completion_snapshot(world, before, after, expected):
    tasks, sessions, _, service = world
    task = routine(tasks, [{"kind": "run_event", "on": "failed", "filters": {"priority": "high"}}])
    source = tasks.create_task({"title": "Build at completion", "priority": before, "ownerUserId": "alice"})
    session = sessions.create_session({"workspacePath": "/w", "taskGoal": "Build", "participants": ["human"]})
    tasks.link_session(source["id"], session["id"])
    sessions.append_event(session["id"], relay_event("agent.completed", session["id"], {
        "runId": "run_1", "agent": "codex", "status": "failed", "exitCode": 1}))
    tasks.update_task(source["id"], {"priority": after, "title": "Edited after completion"})
    assert service.tick(datetime.now(UTC)) == expected
    if expected:
        [occurrence] = occurrences(tasks, task)
        assert "Build at completion" in occurrence["description"]
        assert "Edited after completion" not in occurrence["description"]


def test_legacy_due_schedule_keeps_its_seed_on_v2_save(world, monkeypatch):
    monkeypatch.setenv("RELAY_TASK_SCHEDULER_TIMEZONE", "UTC")
    tasks, _, _, service = world
    task = tasks.create_task({"title": "Legacy", "isRoutine": True, "routineEnabled": True,
                              "routineCadence": "custom", "routineNextRunDate": "2026-10-13",
                              "assignedAgent": "codex"})
    now = datetime(2026, 10, 13, 10, tzinfo=UTC)
    tasks.update_task(task["id"], routine_fields_v2({"routineTriggers": task["routineTriggers"]},
                                                  current=task, now=now))
    assert service.tick(now) == 1
    tasks.update_task(occurrences(tasks, task)[0]["id"], {"status": "done"})
    assert service.tick(now) == 0


def test_exhausted_once_stays_exhausted_on_ordinary_edit(world):
    tasks, _, _, service = world
    trigger = schedule({"once": "2026-10-13T09:00"})
    task = routine(tasks, [trigger], routineNextRunAt="2026-10-13T09:00:00+00:00")
    now = datetime(2026, 10, 13, 10, tzinfo=UTC)
    assert service.tick(now) == 1
    task = tasks.get_task(task["id"])
    tasks.update_task(task["id"], routine_fields_v2({"routineTriggers": [trigger]}, current=task, now=now))
    tasks.update_task(occurrences(tasks, task)[0]["id"], {"status": "done"})
    assert service.tick(now) == 0


def test_shared_schedule_slot_survives_removing_one_source(world):
    tasks, _, _, service = world
    first = schedule({"every": "day", "at": "09:00"})
    second = schedule({"every": "week", "at": "09:00", "days": [2]})
    task = routine(tasks, [first, second], routineNextRunAt="2026-10-13T09:00:00+00:00")
    now = datetime(2026, 10, 13, 9, 0, 2, tzinfo=UTC)
    service.clock.run(now)
    tasks.update_task(task["id"], {"routineTriggers": [second]})
    assert service.tick(now) == 1


def test_run_completion_keeps_provenance_after_unlinking_task(world):
    tasks, sessions, automations, service = world
    task = routine(tasks, [{"kind": "run_event", "on": "failed"}])
    occurrence = tasks.create_triggered_occurrence(task["id"], run_date="2026-10-13",
                                                   trigger_kind="manual", depth=2, context="")
    session = sessions.create_session({"workspacePath": "/w", "taskGoal": "Run", "participants": ["human"]})
    tasks.link_session(occurrence["id"], session["id"])
    sessions.append_event(session["id"], relay_event("agent.completed", session["id"], {
        "runId": "run_1", "agent": "codex", "status": "failed", "exitCode": 1}))
    tasks.unlink_session(occurrence["id"], session["id"])
    tasks.update_task(occurrence["id"], {"status": "review"})
    rows = automations.claim_outbox(10, datetime.now(UTC))
    [row] = [row for row in rows if row["kind"] == "run_event"]
    assert row["origin_automation_id"] == task["id"]
    assert row["depth"] == 3
    assert row["payload"]["subject"]["id"] == occurrence["id"]
    # Put the claim back within reach of the service and check its self-loop guard.
    assert service.tick(datetime.now(UTC) + timedelta(minutes=6)) == 0
    assert len(occurrences(tasks, task)) == 1


def test_legacy_pending_schedule_is_invalidated_by_replacement(world):
    tasks, _, automations, service = world
    now = datetime.now(UTC)
    task = routine(tasks, [schedule({"every": "day", "at": "11:00"})])
    # A pending row written by the previous backend has a summary but no source stamp.
    automations.mark_pending(task["id"], {"eventType": "schedule", "summary": "Daily at 09:00 (UTC)", "depth": 0}, now)
    assert service.tick(now) == 0
    assert occurrences(tasks, task) == []


def test_resume_cutoff_is_recorded_after_waiting_for_automation_lock(world, monkeypatch):
    from relay.automations import service as module

    tasks, _, automations, service = world
    task = routine(tasks, [{"kind": "webhook"}], routineState="paused")
    requested_at = datetime.now(UTC)
    original = module.lock_automation_state
    inserted = False

    def delayed_lock(conn):
        nonlocal inserted
        if not inserted:
            inserted = True
            automations.enqueue_webhook(task["id"], {"before_activation": True})
        original(conn)

    monkeypatch.setattr(module, "lock_automation_state", delayed_lock)
    service.resume(task["id"], {"userId": "alice", "isAdmin": False}, requested_at)
    assert service.tick(datetime.now(UTC)) == 0
