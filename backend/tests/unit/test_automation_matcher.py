from __future__ import annotations

from datetime import date, datetime, timedelta, timezone
from tempfile import TemporaryDirectory

import pytest
from relay.automations.matcher import AutomationMatcher
from relay.persistence.automation_store import DatabaseAutomationStore
from relay.persistence.session_store import DatabaseSessionStore
from relay.persistence.task_store import DatabaseTaskStore

ON_BLOCKED = {"kind": "task_event", "on": "status_changed", "filters": {"toStatus": "blocked"}}


class Clock:
    def __init__(self) -> None:
        self.value = datetime(2026, 10, 2, 12, tzinfo=timezone.utc)

    def __call__(self) -> datetime:
        return self.value


@pytest.fixture
def world():
    with TemporaryDirectory() as root:
        url = f"sqlite:///{root}/relay.db"
        tasks = DatabaseTaskStore(url, create_schema=True)
        sessions = DatabaseSessionStore(url, create_schema=True)
        automations = DatabaseAutomationStore(url, create_schema=True)
        clock = Clock()
        matcher = AutomationMatcher(task_store=tasks, session_store=sessions, automation_store=automations,
                                    now=clock, today=lambda: date(2026, 10, 2))
        yield tasks, automations, matcher, clock


def _automation(tasks, trigger=ON_BLOCKED, **extra):
    return tasks.create_task({"title": "Triage", "description": "Fix it.", "isRoutine": True,
                              "routineEnabled": True, "assignedAgent": "codex", "assignedAgentId": "agent_1",
                              "routineTrigger": trigger, **extra})


def _block(tasks, title="Nightly import"):
    task = tasks.create_task({"title": title})
    return tasks.update_task(task["id"], {"status": "blocked", "blockerReason": "stuck"})


def _occurrences(tasks, routine_id):
    return [task for task in tasks.list_tasks() if task.get("sourceRoutineId") == routine_id]


def test_matching_event_fires_one_occurrence_with_context(world) -> None:
    tasks, _, matcher, _ = world
    routine = _automation(tasks)
    _block(tasks)
    assert matcher.run() == 1
    [occurrence] = _occurrences(tasks, routine["id"])
    assert "Trigger context" in occurrence["description"]
    assert '"Nightly import" — backlog → blocked' in occurrence["description"]


def test_non_matching_event_does_nothing(world) -> None:
    tasks, _, matcher, _ = world
    routine = _automation(tasks, {"kind": "task_event", "on": "status_changed", "filters": {"toStatus": "done"}})
    _block(tasks)
    assert matcher.run() == 0
    assert _occurrences(tasks, routine["id"]) == []


def test_burst_while_running_coalesces_into_one_next_run(world) -> None:
    tasks, automations, matcher, _ = world
    routine = _automation(tasks)
    _block(tasks, "first")
    matcher.run()
    [first] = _occurrences(tasks, routine["id"])
    tasks.update_task(first["id"], {"status": "running"})
    for index in range(3):
        _block(tasks, f"burst {index}")
    assert matcher.run() == 0
    assert automations.get_state(routine["id"])["pending"] is True
    tasks.update_task(first["id"], {"status": "done"})
    assert matcher.run() == 1
    second = [task for task in _occurrences(tasks, routine["id"]) if task["id"] != first["id"]][0]
    assert "(3 events" in second["description"]


def test_parked_occurrence_does_not_hold_events(world) -> None:
    tasks, _, matcher, _ = world
    routine = _automation(tasks)
    _block(tasks, "first")
    matcher.run()
    [first] = _occurrences(tasks, routine["id"])
    tasks.update_task(first["id"], {"status": "review"})
    _block(tasks, "second")
    assert matcher.run() == 1


def test_own_occurrence_never_refires(world) -> None:
    tasks, _, matcher, _ = world
    routine = _automation(tasks)
    _block(tasks)
    matcher.run()
    [occurrence] = _occurrences(tasks, routine["id"])
    tasks.update_task(occurrence["id"], {"status": "blocked", "blockerReason": "loop?"})
    assert matcher.run() == 0
    assert len(_occurrences(tasks, routine["id"])) == 1


def test_chains_stop_past_max_depth(world) -> None:
    tasks, _, matcher, _ = world
    _automation(tasks)
    deep = tasks.create_task({"title": "deep", "sourceRoutineId": "other", "routineTriggerDepth": 3})
    tasks.update_task(deep["id"], {"status": "blocked", "blockerReason": "x"})
    assert matcher.run() == 0


def test_rate_cap_pauses_the_automation(world) -> None:
    tasks, _, matcher, clock = world
    routine = _automation(tasks)
    for index in range(7):
        _block(tasks, f"t{index}")
        matcher.run()
        for occurrence in _occurrences(tasks, routine["id"]):
            if occurrence["status"] != "done":
                tasks.update_task(occurrence["id"], {"status": "done"})
        clock.value += timedelta(minutes=1)
    paused = tasks.get_task(routine["id"])
    assert len(_occurrences(tasks, routine["id"])) == 6
    assert paused["routineEnabled"] is False
    assert paused["routineDisabledReason"] == "rate_limited"


def test_webhook_rows_reach_only_their_automation(world) -> None:
    tasks, automations, matcher, _ = world
    hooked = _automation(tasks, {"kind": "webhook"})
    other = _automation(tasks, {"kind": "webhook"})
    automations.enqueue_webhook(hooked["id"], {"ref": "main"})
    assert matcher.run() == 1
    [occurrence] = _occurrences(tasks, hooked["id"])
    assert '"ref": "main"' in occurrence["description"]
    assert _occurrences(tasks, other["id"]) == []


def test_deleted_automation_clears_pending_state(world) -> None:
    tasks, automations, matcher, _ = world
    routine = _automation(tasks)
    automations.save_state(routine["id"], {**automations.get_state(routine["id"]), "pending": True,
                                           "pending_events": [{"eventType": "webhook", "payload": {}, "depth": 0}],
                                           "pending_since": datetime(2026, 10, 2, tzinfo=timezone.utc)})
    tasks.delete_task(routine["id"])
    assert matcher.run() == 0
    assert automations.list_pending_states() == []


def test_pending_events_expire_after_a_day(world) -> None:
    tasks, automations, matcher, clock = world
    routine = tasks.create_task({"title": "No target", "isRoutine": True, "routineEnabled": True,
                                 "routineTrigger": ON_BLOCKED})
    _block(tasks)
    matcher.run()
    assert automations.get_state(routine["id"])["pending"] is True
    clock.value += timedelta(hours=25)
    matcher.run()
    assert automations.list_pending_states() == []
