from __future__ import annotations

from tempfile import TemporaryDirectory

import pytest
from relay.persistence.task_store import DatabaseTaskStore, LocalTaskStore

ON_BLOCKED = {"kind": "task_event", "on": "status_changed", "filters": {"toStatus": "blocked"}}


@pytest.fixture(params=["database", "local"])
def store(request):
    with TemporaryDirectory() as root:
        yield (DatabaseTaskStore(f"sqlite:///{root}/relay.db", create_schema=True)
               if request.param == "database" else LocalTaskStore(root))


def _automation(store, **extra):
    return store.create_task({
        "title": "Triage", "description": "Look into it.", "isRoutine": True, "routineEnabled": True,
        "assignedAgent": "codex", "assignedAgentId": "agent_1", "routineTrigger": ON_BLOCKED, **extra,
    })


def test_triggered_occurrences_are_never_deduped_by_date(store) -> None:
    routine = _automation(store)
    first = store.create_triggered_occurrence(routine["id"], run_date="2026-10-02", trigger_kind="task_event",
                                              depth=1, context="---\nTrigger context\nFired by: Task created")
    second = store.create_triggered_occurrence(routine["id"], run_date="2026-10-02", trigger_kind="task_event",
                                               depth=1, context="ctx")
    assert first["id"] != second["id"]
    assert first["description"] == "Look into it.\n\n---\nTrigger context\nFired by: Task created"
    assert first["routineTriggerKind"] == "task_event"
    assert first["routineTriggerDepth"] == 1
    assert first["sourceRoutineId"] == routine["id"]
    assert first["status"] == "assigned"
    updated = store.get_task(routine["id"])
    assert "routineNextRunDate" not in updated
    assert updated["occurrenceIds"][-2:] == [first["id"], second["id"]]


def test_disabled_or_unassigned_automation_creates_nothing(store) -> None:
    paused = _automation(store, routineEnabled=False)
    assert store.create_triggered_occurrence(paused["id"], run_date="2026-10-02", trigger_kind="task_event",
                                             depth=0, context="ctx") is None
    unassigned = store.create_task({"title": "x", "isRoutine": True, "routineEnabled": True,
                                    "routineTrigger": {"kind": "webhook"}})
    assert store.create_triggered_occurrence(unassigned["id"], run_date="2026-10-02", trigger_kind="webhook",
                                             depth=0, context="ctx") is None


def test_lists_only_enabled_event_and_webhook_automations(store) -> None:
    listening = _automation(store)
    webhook = _automation(store, routineTrigger={"kind": "webhook"})
    _automation(store, routineTrigger={"kind": "manual"})
    _automation(store, routineTrigger={"kind": "schedule"}, routineCadence="weekly", routineNextRunDate="2026-10-09")
    _automation(store, routineEnabled=False)
    assert {task["id"] for task in store.list_trigger_automations()} == {listening["id"], webhook["id"]}
