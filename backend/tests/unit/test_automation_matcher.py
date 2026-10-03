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


def test_pending_cap_counts_overflow(world):
    tasks, automations, matcher, _ = world
    routine = _automation(tasks, assignedAgentId=None, assignedAgent=None)
    for index in range(25):
        _block(tasks, f"burst {index}")
    assert matcher.run() == 0
    state = automations.get_state(routine["id"])
    assert len(state["pending_events"]) == 20
    assert state["pending_dropped"] == 5


def test_failed_firing_rolls_back_outbox_and_pending(world, monkeypatch):
    tasks, automations, matcher, clock = world
    routine = _automation(tasks)
    _block(tasks)
    original = tasks.create_triggered_occurrence
    def fail(*args, **kwargs):
        original(*args, **kwargs)
        raise RuntimeError("interrupted")
    monkeypatch.setattr(tasks, "create_triggered_occurrence", fail)
    with pytest.raises(RuntimeError):
        matcher.run()
    assert _occurrences(tasks, routine["id"]) == []
    assert automations.list_pending_states() == []
    assert len(automations.claim_outbox(10, clock())) == 2


def test_scheduler_tick_fires_automation_through_app(monkeypatch, tmp_path):
    import asyncio
    from relay.app import create_app
    monkeypatch.setenv("RELAY_ADMIN_TOKEN", "test-admin")
    monkeypatch.setenv("RELAY_TASK_SCHEDULER_ENABLED", "1")
    monkeypatch.setenv("RELAY_TASK_SCHEDULER_INTERVAL_SECONDS", "3600")
    app = create_app(tmp_path)
    tasks = app.state.task_store
    routine = _automation(tasks)
    _block(tasks)
    result = asyncio.run(app.state.task_scheduler.tick())
    assert result.fired == 1
    assert len(_occurrences(tasks, routine["id"])) == 1


def test_run_completion_uses_linked_task_filters_and_loop_provenance(world):
    from relay.persistence.store_common import relay_event
    tasks, _, matcher, _ = world
    routine = _automation(tasks, {"kind": "run_event", "on": "failed", "filters": {"priority": "high"}})
    source = tasks.create_task({"title": "Build release", "priority": "high"})
    session = matcher.session_store.create_session({"workspacePath": "/w", "taskGoal": "Build", "participants": ["human"]})
    tasks.link_session(source["id"], session["id"])
    matcher.session_store.append_event(session["id"], relay_event("agent.completed", session["id"], {
        "runId": "run_failed", "agent": "codex", "status": "failed", "exitCode": 1, "error": "Compile failed",
    }))
    assert matcher.run() == 1
    [occurrence] = _occurrences(tasks, routine["id"])
    assert '"Build release" — run failed: Compile failed' in occurrence["description"]
    tasks.link_session(occurrence["id"], session["id"])
    # Use a separate session whose only linked task is the occurrence.
    own_session = matcher.session_store.create_session({"workspacePath": "/w", "taskGoal": "Triage", "participants": ["human"]})
    tasks.link_session(occurrence["id"], own_session["id"])
    matcher.session_store.append_event(own_session["id"], relay_event("agent.completed", own_session["id"], {
        "runId": "run_own", "agent": "codex", "status": "failed", "exitCode": 1,
    }))
    tasks.update_task(occurrence["id"], {"status": "review"})
    assert matcher.run() == 0


def test_disabled_automation_discards_pending(world):
    tasks, automations, matcher, _ = world
    routine = _automation(tasks)
    _block(tasks)
    matcher.run()
    _block(tasks, "burst")
    assert matcher.run() == 0
    tasks.update_task(routine["id"], {"routineEnabled": False})
    assert matcher.run() == 0
    assert automations.list_pending_states() == []
    tasks.update_task(routine["id"], {"routineEnabled": True})
    assert matcher.run() == 0


def test_switch_to_manual_discards_queued_webhook(world) -> None:
    tasks, automations, matcher, clock = world
    routine = _automation(tasks, {"kind": "webhook"})
    automations.save_state(routine["id"], {
        **automations.get_state(routine["id"]), "pending": True,
        "pending_since": clock.value,
        "pending_events": [{"eventType": "webhook", "payload": {}, "depth": 0}],
    })
    tasks.update_task(routine["id"], {"routineTrigger": {"kind": "manual"}})
    assert matcher.run() == 0
    assert not automations.get_state(routine["id"])["pending"]
    assert not _occurrences(tasks, routine["id"])


def test_bad_stored_filter_does_not_block_other_automations(world) -> None:
    tasks, _, matcher, _ = world
    _automation(tasks, {"kind": "task_event", "on": "status_changed",
                        "filters": {"titleContains": 42}})
    good = _automation(tasks)
    _block(tasks)
    assert matcher.run() == 1
    assert len(_occurrences(tasks, good["id"])) == 1


@pytest.mark.parametrize("kind", ["schedule", "manual", "webhook", "task_event"])
def test_manual_requests_share_coalescing_and_hourly_cap(world, kind) -> None:
    tasks, automations, matcher, clock = world
    trigger = ON_BLOCKED if kind == "task_event" else {"kind": kind}
    routine = _automation(tasks, trigger)
    matcher.max_runs_per_hour = 1
    automations.enqueue_manual(routine["id"])
    assert matcher.run() == 1
    [first] = _occurrences(tasks, routine["id"])
    assert first["routineTriggerKind"] == "manual"
    assert first["routineTriggerDepth"] == 0
    automations.enqueue_manual(routine["id"])
    automations.enqueue_manual(routine["id"])
    assert matcher.run() == 0
    assert len(automations.get_state(routine["id"])["pending_events"]) == 2
    tasks.update_task(first["id"], {"status": "done"})
    assert matcher.run() == 0
    assert tasks.get_task(routine["id"])["routineDisabledReason"] == "rate_limited"
    assert len(_occurrences(tasks, routine["id"])) == 1


def test_ledger_metadata_is_authoritative_after_replay(world) -> None:
    from relay.persistence.store_common import materialize_task_events
    from relay.api.task_routes import run_row
    from types import SimpleNamespace
    tasks, _, matcher, _ = world
    routine = _automation(tasks)
    _block(tasks, "one")
    _block(tasks, "two")
    matcher.run()
    [occurrence] = _occurrences(tasks, routine["id"])
    replayed = materialize_task_events(occurrence["events"])
    assert replayed["routineTriggerSummary"] == {
        "eventType": "task.status_changed", "toStatus": "blocked", "eventCount": 2,
    }
    row = run_row(SimpleNamespace(session_store=None), replayed)
    assert row["triggerSummary"] == replayed["routineTriggerSummary"]


def test_unfiltered_automation_does_not_observe_another_owner(world) -> None:
    tasks, _, matcher, _ = world
    routine = _automation(tasks, ownerEmployeeId="alice", assigneeEmployeeId="alice")
    foreign = tasks.create_task({"title": "Private Bob issue", "ownerEmployeeId": "bob"})
    tasks.update_task(foreign["id"], {"status": "blocked", "blockerReason": "private"})
    assert matcher.run() == 0
    assert not _occurrences(tasks, routine["id"])


def test_manual_coalesced_with_a_chain_keeps_its_depth_and_label(world) -> None:
    tasks, automations, matcher, _ = world
    routine = _automation(tasks)
    chained = tasks.create_task({"title": "chained", "sourceRoutineId": "other", "routineTriggerDepth": 1})
    tasks.update_task(chained["id"], {"status": "blocked", "blockerReason": "x"})
    automations.enqueue_manual(routine["id"])
    assert matcher.run() == 1
    [occurrence] = _occurrences(tasks, routine["id"])
    assert occurrence["routineTriggerKind"] == "manual"
    assert occurrence["routineTriggerDepth"] == 2
    assert "Fired by: Manual (2 events)" in occurrence["description"]


def test_in_flight_check_reads_only_recent_occurrences() -> None:
    from relay.automations.matcher import IN_FLIGHT_LOOKBACK, in_flight_occurrence

    class Store:
        def __init__(self) -> None:
            self.reads: list[str] = []

        def get_task(self, task_id: str) -> dict:
            self.reads.append(task_id)
            return {"id": task_id, "status": "done"}

    store = Store()
    routine = {"occurrenceIds": [f"occ_{index}" for index in range(500)]}
    assert in_flight_occurrence(store, routine) is None
    assert len(store.reads) == IN_FLIGHT_LOOKBACK
    assert store.reads[0] == "occ_499"


@pytest.mark.parametrize("enabled, expected", [("1", True), ("0", False)])
def test_outbox_rows_are_written_only_when_a_matcher_drains_them(monkeypatch, tmp_path, enabled, expected):
    from relay.app import create_app
    monkeypatch.setenv("RELAY_ADMIN_TOKEN", "test-admin")
    monkeypatch.setenv("RELAY_TASK_SCHEDULER_ENABLED", enabled)
    app = create_app(tmp_path)
    _block(app.state.task_store)
    rows = app.state.automation_store.claim_outbox(100, datetime.now(timezone.utc))
    assert bool(rows) is expected
