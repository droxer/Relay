from datetime import datetime, UTC
from tempfile import TemporaryDirectory

import pytest
from relay.automations.clock import ScheduleClock
from relay.persistence.automation.store import DatabaseAutomationStore
from relay.persistence.engine import store_transaction
from relay.persistence.task.store import DatabaseTaskStore

UTC = UTC
DAILY_9 = [{"kind": "schedule", "schedule": {"timezone": "UTC", "repeat": {"every": "day", "at": "09:00"}}}]
DAILY_7 = [{"kind": "schedule", "schedule": {"timezone": "UTC", "repeat": {"every": "day", "at": "07:00"}}}]


@pytest.fixture
def world(monkeypatch):
    monkeypatch.setenv("RELAY_TASK_SCHEDULER_TIMEZONE", "UTC")
    with TemporaryDirectory() as root:
        url = f"sqlite:///{root}/relay.db"
        tasks = DatabaseTaskStore(url, create_schema=True)
        automations = DatabaseAutomationStore(url, create_schema=True)
        yield tasks, automations, ScheduleClock(task_store=tasks, automation_store=automations)


def _routine(tasks, **extra):
    return tasks.create_task({"title": "Digest", "isRoutine": True, "routineTriggers": DAILY_9,
                              "routineState": "active", "assignedAgent": "codex", "assignedAgentId": "a1", **extra})


def test_unseeded_schedule_gets_next_run_without_firing(world):
    tasks, automations, clock = world
    routine = _routine(tasks)
    assert clock.run(datetime(2026, 10, 13, 8, tzinfo=UTC)) == 0
    assert tasks.get_task(routine["id"])["routineNextRunAt"] == "2026-10-13T09:00:00+00:00"
    assert automations.get_state(routine["id"])["pending"] is False


def test_legacy_routine_seeds_from_its_date_and_fires_when_past(world):
    tasks, automations, clock = world
    routine = tasks.create_task({"title": "Old", "isRoutine": True, "routineCadence": "daily",
                                 "routineNextRunDate": "2026-10-12", "routineEnabled": True, "assignedAgent": "codex"})
    assert clock.run(datetime(2026, 10, 13, 8, tzinfo=UTC)) == 1   # seeded 2026-10-12T00:00Z, already due
    assert automations.get_state(routine["id"])["pending"] is True
    assert tasks.get_task(routine["id"])["routineNextRunAt"] == "2026-10-14T00:00:00+00:00"


def test_due_schedule_marks_pending_and_advances(world):
    tasks, automations, clock = world
    routine = _routine(tasks, routineNextRunAt="2026-10-13T09:00:00+00:00")
    assert clock.run(datetime(2026, 10, 13, 9, 0, 5, tzinfo=UTC)) == 1
    state = automations.get_state(routine["id"])
    assert state["pending"] and state["pending_events"][0]["eventType"] == "schedule"
    assert state["pending_events"][0]["summary"] == "Daily at 09:00 (UTC)"
    assert tasks.get_task(routine["id"])["routineNextRunAt"] == "2026-10-14T09:00:00+00:00"


def test_missed_slots_collapse_to_one(world):
    tasks, automations, clock = world
    routine = _routine(tasks, routineNextRunAt="2026-10-10T09:00:00+00:00")
    assert clock.run(datetime(2026, 10, 13, 12, tzinfo=UTC)) == 1
    assert len(automations.get_state(routine["id"])["pending_events"]) == 1
    assert tasks.get_task(routine["id"])["routineNextRunAt"] == "2026-10-14T09:00:00+00:00"


def test_once_clears_next_run_after_firing(world):
    tasks, _, clock = world
    once = [{"kind": "schedule", "schedule": {"timezone": "UTC", "repeat": {"once": "2026-10-13T09:00"}}}]
    routine = _routine(tasks, routineTriggers=once, routineNextRunAt="2026-10-13T09:00:00+00:00")
    clock.run(datetime(2026, 10, 13, 9, 1, tzinfo=UTC))
    assert "routineNextRunAt" not in tasks.get_task(routine["id"])


def test_paused_routine_is_ignored(world):
    tasks, automations, clock = world
    routine = _routine(tasks, routineState="paused", routineNextRunAt="2026-10-13T09:00:00+00:00")
    assert clock.run(datetime(2026, 10, 13, 10, tzinfo=UTC)) == 0
    assert automations.get_state(routine["id"])["pending"] is False


def test_earliest_of_two_schedules_wins(world):
    tasks, _, clock = world
    routine = _routine(tasks, routineTriggers=[*DAILY_9, *DAILY_7])
    clock.run(datetime(2026, 10, 13, 6, tzinfo=UTC))
    assert tasks.get_task(routine["id"])["routineNextRunAt"] == "2026-10-13T07:00:00+00:00"


def test_summary_names_the_trigger_that_came_due(world):
    tasks, automations, clock = world
    routine = _routine(tasks, routineTriggers=[*DAILY_9, *DAILY_7], routineNextRunAt="2026-10-13T07:00:00+00:00")
    clock.run(datetime(2026, 10, 13, 7, 0, 5, tzinfo=UTC))
    assert automations.get_state(routine["id"])["pending_events"][0]["summary"] == "Daily at 07:00 (UTC)"


def test_failed_pending_write_does_not_advance(world, monkeypatch):
    tasks, automations, clock = world
    routine = _routine(tasks, routineNextRunAt="2026-10-13T09:00:00+00:00")
    monkeypatch.setattr(automations, "mark_pending", lambda *a, **k: (_ for _ in ()).throw(RuntimeError("boom")))
    with pytest.raises(RuntimeError):
        with store_transaction(automations.engine):
            clock.run(datetime(2026, 10, 13, 9, 1, tzinfo=UTC))
    assert tasks.get_task(routine["id"])["routineNextRunAt"] == "2026-10-13T09:00:00+00:00"


def test_exhausted_schedule_is_not_rewritten_every_tick(world):
    tasks, _, clock = world
    once = [{"kind": "schedule", "schedule": {"timezone": "UTC", "repeat": {"once": "2026-10-13T09:00"}}}]
    routine = _routine(tasks, routineTriggers=once, routineNextRunAt="2026-10-13T09:00:00+00:00")
    clock.run(datetime(2026, 10, 13, 9, 1, tzinfo=UTC))
    version = len(tasks.get_task(routine["id"])["events"])
    clock.run(datetime(2026, 10, 13, 9, 2, tzinfo=UTC))
    clock.run(datetime(2026, 10, 13, 9, 3, tzinfo=UTC))
    assert len(tasks.get_task(routine["id"])["events"]) == version


def test_failed_firing_rolls_back_the_clock_advance(world, monkeypatch):
    from relay.automations.service import AutomationService
    from relay.persistence.session.store import DatabaseSessionStore

    tasks, automations, _ = world
    sessions = DatabaseSessionStore(str(tasks.engine.url), create_schema=True)
    service = AutomationService(task_store=tasks, session_store=sessions, automation_store=automations,
                                project_store=None)
    routine = _routine(tasks, routineNextRunAt="2026-10-13T09:00:00+00:00")
    monkeypatch.setattr(service.firing, "fire_one", lambda *args: (_ for _ in ()).throw(RuntimeError("boom")))
    assert service.tick(datetime(2026, 10, 13, 9, 1, tzinfo=UTC)) == 0
    assert tasks.get_task(routine["id"])["routineNextRunAt"] == "2026-10-13T09:00:00+00:00"
    assert automations.get_state(routine["id"])["pending"] is False


def test_bad_schedule_firing_does_not_roll_back_healthy_schedule(world, monkeypatch):
    from relay.automations.service import AutomationService
    from relay.persistence.session.store import DatabaseSessionStore

    tasks, automations, _ = world
    sessions = DatabaseSessionStore(str(tasks.engine.url), create_schema=True)
    service = AutomationService(task_store=tasks, session_store=sessions, automation_store=automations,
                                project_store=None)
    bad = _routine(tasks, routineNextRunAt="2026-10-13T09:00:00+00:00")
    good = _routine(tasks, routineNextRunAt="2026-10-13T09:00:00+00:00")
    original = tasks.create_triggered_occurrence

    def fail_bad(routine_id, **kwargs):
        result = original(routine_id, **kwargs)
        if routine_id == bad["id"]:
            raise RuntimeError("failed after creating the occurrence")
        return result

    monkeypatch.setattr(tasks, "create_triggered_occurrence", fail_bad)
    now = datetime(2026, 10, 13, 9, 1, tzinfo=UTC)
    assert service.tick(now) == 1
    assert tasks.get_task(bad["id"])["routineNextRunAt"] == "2026-10-13T09:00:00+00:00"
    assert tasks.get_task(bad["id"]).get("occurrenceIds", []) == []
    assert automations.get_state(bad["id"])["pending"] is False
    assert tasks.get_task(good["id"])["routineNextRunAt"] == "2026-10-14T09:00:00+00:00"
    assert len(tasks.get_task(good["id"])["occurrenceIds"]) == 1
    monkeypatch.setattr(tasks, "create_triggered_occurrence", original)
    assert service.tick(now) == 1
    assert len(tasks.get_task(bad["id"])["occurrenceIds"]) == 1
    assert len(tasks.get_task(good["id"])["occurrenceIds"]) == 1


def test_outer_failure_rolls_back_released_schedule_savepoint(world, monkeypatch):
    from relay.automations.service import AutomationService
    from relay.persistence.session.store import DatabaseSessionStore

    tasks, automations, _ = world
    sessions = DatabaseSessionStore(str(tasks.engine.url), create_schema=True)
    service = AutomationService(task_store=tasks, session_store=sessions, automation_store=automations,
                                project_store=None)
    routine = _routine(tasks, routineNextRunAt="2026-10-13T09:00:00+00:00")
    monkeypatch.setattr(service.matcher, "finish", lambda *args: (_ for _ in ()).throw(RuntimeError("outbox finalization failed")))
    assert service.tick(datetime(2026, 10, 13, 9, 1, tzinfo=UTC)) == 0
    assert tasks.get_task(routine["id"])["routineNextRunAt"] == "2026-10-13T09:00:00+00:00"
    assert tasks.get_task(routine["id"]).get("occurrenceIds", []) == []
    assert automations.get_state(routine["id"])["pending"] is False
