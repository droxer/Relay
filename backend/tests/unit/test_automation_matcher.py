from __future__ import annotations

from datetime import datetime, timedelta, timezone
from tempfile import TemporaryDirectory

import pytest
from relay.automations.service import AutomationService
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
        service = AutomationService(task_store=tasks, session_store=sessions, automation_store=automations,
                                    project_store=None, max_runs_per_hour=6, batch=200)
        yield tasks, automations, service, Clock()


def run(world) -> int:
    """One automation tick at the test clock's time, as the scheduler runs it."""
    return world[2].tick(world[3].value)


DAILY_9_UTC = [{"kind": "schedule", "schedule": {"timezone": "UTC", "repeat": {"every": "day", "at": "09:00"}}}]


def _triggers(trigger):
    if trigger["kind"] == "manual":
        return []
    return DAILY_9_UTC if trigger["kind"] == "schedule" else [trigger]


def _automation(tasks, trigger=ON_BLOCKED, **extra):
    return tasks.create_task({"title": "Triage", "description": "Fix it.", "isRoutine": True,
                              "routineState": "active", "assignedAgent": "codex", "assignedAgentId": "agent_1",
                              "routineTriggers": _triggers(trigger), **extra})


def _block(tasks, title="Nightly import"):
    task = tasks.create_task({"title": title})
    return tasks.update_task(task["id"], {"status": "blocked", "blockerReason": "stuck"})


def _occurrences(tasks, routine_id):
    return [task for task in tasks.list_tasks() if task.get("sourceRoutineId") == routine_id]


def test_matching_event_fires_one_occurrence_with_context(world) -> None:
    tasks, _, service, _ = world
    routine = _automation(tasks)
    _block(tasks)
    assert run(world) == 1
    [occurrence] = _occurrences(tasks, routine["id"])
    assert "Trigger context" in occurrence["description"]
    assert '"Nightly import" — backlog → blocked' in occurrence["description"]


def test_non_matching_event_does_nothing(world) -> None:
    tasks, _, service, _ = world
    routine = _automation(tasks, {"kind": "task_event", "on": "status_changed", "filters": {"toStatus": "done"}})
    _block(tasks)
    assert run(world) == 0
    assert _occurrences(tasks, routine["id"]) == []


def test_burst_while_running_coalesces_into_one_next_run(world) -> None:
    tasks, automations, service, _ = world
    routine = _automation(tasks)
    _block(tasks, "first")
    run(world)
    [first] = _occurrences(tasks, routine["id"])
    tasks.update_task(first["id"], {"status": "running"})
    for index in range(3):
        _block(tasks, f"burst {index}")
    assert run(world) == 0
    assert automations.get_state(routine["id"])["pending"] is True
    tasks.update_task(first["id"], {"status": "done"})
    assert run(world) == 1
    second = [task for task in _occurrences(tasks, routine["id"]) if task["id"] != first["id"]][0]
    assert "(3 events" in second["description"]


def test_parked_occurrence_does_not_hold_events(world) -> None:
    tasks, _, service, _ = world
    routine = _automation(tasks)
    _block(tasks, "first")
    run(world)
    [first] = _occurrences(tasks, routine["id"])
    tasks.update_task(first["id"], {"status": "review"})
    _block(tasks, "second")
    assert run(world) == 1


def test_own_occurrence_never_refires(world) -> None:
    tasks, _, service, _ = world
    routine = _automation(tasks)
    _block(tasks)
    run(world)
    [occurrence] = _occurrences(tasks, routine["id"])
    tasks.update_task(occurrence["id"], {"status": "blocked", "blockerReason": "loop?"})
    assert run(world) == 0
    assert len(_occurrences(tasks, routine["id"])) == 1


def test_chains_stop_past_max_depth(world) -> None:
    tasks, _, service, _ = world
    _automation(tasks)
    deep = tasks.create_task({"title": "deep", "sourceRoutineId": "other", "routineTriggerDepth": 3})
    tasks.update_task(deep["id"], {"status": "blocked", "blockerReason": "x"})
    assert run(world) == 0


def test_rate_cap_pauses_the_automation(world) -> None:
    tasks, _, service, clock = world
    routine = _automation(tasks)
    for index in range(7):
        _block(tasks, f"t{index}")
        run(world)
        for occurrence in _occurrences(tasks, routine["id"]):
            if occurrence["status"] != "done":
                tasks.update_task(occurrence["id"], {"status": "done"})
        clock.value += timedelta(minutes=1)
    paused = tasks.get_task(routine["id"])
    assert len(_occurrences(tasks, routine["id"])) == 6
    # The cap pauses through the v2 fields, which drop the legacy keys.
    assert (paused["routineState"], paused["routinePauseReason"]) == ("paused_by_relay", "rate_limited")


def test_webhook_rows_reach_only_their_automation(world) -> None:
    tasks, automations, service, _ = world
    hooked = _automation(tasks, {"kind": "webhook"})
    other = _automation(tasks, {"kind": "webhook"})
    automations.enqueue_webhook(hooked["id"], {"ref": "main"})
    assert run(world) == 1
    [occurrence] = _occurrences(tasks, hooked["id"])
    assert '"ref": "main"' in occurrence["description"]
    assert _occurrences(tasks, other["id"]) == []


def test_deleted_automation_clears_pending_state(world) -> None:
    tasks, automations, service, _ = world
    routine = _automation(tasks)
    automations.save_state(routine["id"], {**automations.get_state(routine["id"]), "pending": True,
                                           "pending_events": [{"eventType": "webhook", "payload": {}, "depth": 0}],
                                           "pending_since": datetime(2026, 10, 2, tzinfo=timezone.utc)})
    tasks.delete_task(routine["id"])
    assert run(world) == 0
    assert automations.list_pending_states() == []


def test_pending_events_expire_after_a_day(world) -> None:
    tasks, automations, service, clock = world
    routine = _automation(tasks)
    _block(tasks, "first")
    run(world)
    [first] = _occurrences(tasks, routine["id"])
    tasks.update_task(first["id"], {"status": "running"})
    _block(tasks, "held behind the running one")
    run(world)
    assert automations.get_state(routine["id"])["pending"] is True
    tasks.update_task(first["id"], {"status": "done"})
    clock.value += timedelta(hours=25)
    run(world)
    assert automations.list_pending_states() == []


def test_pending_cap_counts_overflow(world):
    tasks, automations, service, clock = world
    routine = _automation(tasks, assignedAgentId=None, assignedAgent=None)
    for index in range(25):
        _block(tasks, f"burst {index}")
    service.matcher.drain(clock.value)
    state = automations.get_state(routine["id"])
    assert len(state["pending_events"]) == 20
    assert state["pending_dropped"] == 5


def test_failed_firing_rolls_back_outbox_and_pending(world, monkeypatch):
    tasks, automations, service, clock = world
    routine = _automation(tasks)
    _block(tasks)
    original = tasks.create_triggered_occurrence
    def fail(*args, **kwargs):
        original(*args, **kwargs)
        raise RuntimeError("interrupted")
    monkeypatch.setattr(tasks, "create_triggered_occurrence", fail)
    assert run(world) == 0  # the tick logs the failure and rolls back
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
    tasks, _, service, _ = world
    routine = _automation(tasks, {"kind": "run_event", "on": "failed", "filters": {"priority": "high"}})
    source = tasks.create_task({"title": "Build release", "priority": "high"})
    session = service.matcher.session_store.create_session({"workspacePath": "/w", "taskGoal": "Build", "participants": ["human"]})
    tasks.link_session(source["id"], session["id"])
    service.matcher.session_store.append_event(session["id"], relay_event("agent.completed", session["id"], {
        "runId": "run_failed", "agent": "codex", "status": "failed", "exitCode": 1, "error": "Compile failed",
    }))
    assert run(world) == 1
    [occurrence] = _occurrences(tasks, routine["id"])
    assert '"Build release" — run failed: Compile failed' in occurrence["description"]
    tasks.link_session(occurrence["id"], session["id"])
    # Use a separate session whose only linked task is the occurrence.
    own_session = service.matcher.session_store.create_session({"workspacePath": "/w", "taskGoal": "Triage", "participants": ["human"]})
    tasks.link_session(occurrence["id"], own_session["id"])
    service.matcher.session_store.append_event(own_session["id"], relay_event("agent.completed", own_session["id"], {
        "runId": "run_own", "agent": "codex", "status": "failed", "exitCode": 1,
    }))
    tasks.update_task(occurrence["id"], {"status": "review"})
    assert run(world) == 0


def test_disabled_automation_discards_pending(world):
    tasks, automations, service, _ = world
    routine = _automation(tasks)
    _block(tasks)
    run(world)
    _block(tasks, "burst")
    assert run(world) == 0
    tasks.update_task(routine["id"], {"routineState": "paused"})
    assert run(world) == 0
    assert automations.list_pending_states() == []
    tasks.update_task(routine["id"], {"routineState": "active"})
    assert run(world) == 0


def test_switch_to_manual_discards_queued_webhook(world) -> None:
    tasks, automations, service, clock = world
    routine = _automation(tasks, {"kind": "webhook"})
    automations.save_state(routine["id"], {
        **automations.get_state(routine["id"]), "pending": True,
        "pending_since": clock.value,
        "pending_events": [{"eventType": "webhook", "payload": {}, "depth": 0}],
    })
    tasks.update_task(routine["id"], {"routineTriggers": []})
    assert run(world) == 0
    assert not automations.get_state(routine["id"])["pending"]
    assert not _occurrences(tasks, routine["id"])


def test_bad_stored_filter_does_not_block_other_automations(world) -> None:
    tasks, _, service, _ = world
    _automation(tasks, {"kind": "task_event", "on": "status_changed",
                        "filters": {"titleContains": 42}})
    good = _automation(tasks)
    _block(tasks)
    assert run(world) == 1
    assert len(_occurrences(tasks, good["id"])) == 1


@pytest.mark.parametrize("kind", ["schedule", "manual", "webhook", "task_event"])
def test_manual_requests_share_coalescing_and_hourly_cap(world, kind) -> None:
    tasks, automations, service, clock = world
    trigger = ON_BLOCKED if kind == "task_event" else {"kind": kind}
    routine = _automation(tasks, trigger)
    service.firing.max_runs_per_hour = 1
    automations.enqueue_manual(routine["id"])
    assert run(world) == 1
    [first] = _occurrences(tasks, routine["id"])
    assert first["routineTriggerKind"] == "manual"
    assert first["routineTriggerDepth"] == 0
    automations.enqueue_manual(routine["id"])
    automations.enqueue_manual(routine["id"])
    assert run(world) == 0
    assert len(automations.get_state(routine["id"])["pending_events"]) == 2
    tasks.update_task(first["id"], {"status": "done"})
    assert run(world) == 0
    assert tasks.get_task(routine["id"])["routinePauseReason"] == "rate_limited"
    assert len(_occurrences(tasks, routine["id"])) == 1


def test_ledger_metadata_is_authoritative_after_replay(world) -> None:
    from relay.persistence.store_common import materialize_task_events
    from relay.api.task_routes import run_row
    from types import SimpleNamespace
    tasks, _, service, _ = world
    routine = _automation(tasks)
    _block(tasks, "one")
    _block(tasks, "two")
    run(world)
    [occurrence] = _occurrences(tasks, routine["id"])
    replayed = materialize_task_events(occurrence["events"])
    assert replayed["routineTriggerSummary"] == {
        "eventType": "task.status_changed", "toStatus": "blocked", "eventCount": 2,
    }
    row = run_row(SimpleNamespace(session_store=None), replayed)
    assert row["triggerSummary"] == replayed["routineTriggerSummary"]


def test_unfiltered_automation_does_not_observe_another_owner(world) -> None:
    tasks, _, service, _ = world
    routine = _automation(tasks, ownerEmployeeId="alice", assigneeEmployeeId="alice")
    foreign = tasks.create_task({"title": "Private Bob issue", "ownerEmployeeId": "bob"})
    tasks.update_task(foreign["id"], {"status": "blocked", "blockerReason": "private"})
    assert run(world) == 0
    assert not _occurrences(tasks, routine["id"])


def test_manual_coalesced_with_a_chain_keeps_its_depth_and_label(world) -> None:
    tasks, automations, service, _ = world
    routine = _automation(tasks)
    chained = tasks.create_task({"title": "chained", "sourceRoutineId": "other", "routineTriggerDepth": 1})
    tasks.update_task(chained["id"], {"status": "blocked", "blockerReason": "x"})
    automations.enqueue_manual(routine["id"])
    assert run(world) == 1
    [occurrence] = _occurrences(tasks, routine["id"])
    assert occurrence["routineTriggerKind"] == "manual"
    assert occurrence["routineTriggerDepth"] == 2
    assert "Fired by: Manual (2 events)" in occurrence["description"]


def test_in_flight_check_reads_only_recent_occurrences() -> None:
    from relay.automations.firing import IN_FLIGHT_LOOKBACK, in_flight_occurrence

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


def test_rate_cap_on_a_seeded_schedule_keeps_its_triggers(world) -> None:
    tasks, automations, service, clock = world
    routine = tasks.create_task({"title": "Digest", "isRoutine": True, "routineState": "active",
                                 "routineTriggers": DAILY_9_UTC, "routineNextRunAt": "2026-10-03T09:00:00+00:00",
                                 "assignedAgent": "codex", "assignedAgentId": "agent_1"})
    service.firing.max_runs_per_hour = 1
    automations.enqueue_manual(routine["id"])
    assert run(world) == 1
    [first] = _occurrences(tasks, routine["id"])
    tasks.update_task(first["id"], {"status": "done"})
    automations.enqueue_manual(routine["id"])
    assert run(world) == 0
    paused = tasks.get_task(routine["id"])
    assert paused["routineTriggers"] == DAILY_9_UTC
    assert (paused["routineState"], paused["routinePauseReason"]) == ("paused_by_relay", "rate_limited")
    assert "routineNextRunAt" not in paused
    assert not {"routineEnabled", "routineDisabledReason", "routineCadence"} & paused.keys()


def test_run_now_on_a_rate_limited_v2_routine_answers_rate_limited() -> None:
    from relay.automations.service import request_manual_occurrence
    routine = {"id": "r1", "isRoutine": True, "routineState": "paused_by_relay", "routinePauseReason": "rate_limited",
               "routineTriggers": DAILY_9_UTC}
    result = request_manual_occurrence(None, None, routine, {"isAdmin": True})
    assert result["dispatch"]["state"] == "rejected"
    assert result["dispatch"]["code"] == "rate_limited"


def test_run_now_refuses_a_rate_limited_automation_up_front() -> None:
    from relay.automations.service import request_manual_occurrence
    routine = {"id": "r1", "isRoutine": True, "routineState": "paused_by_relay", "routinePauseReason": "rate_limited"}
    result = request_manual_occurrence(None, None, routine, {"isAdmin": True})
    assert (result["dispatch"]["state"], result["dispatch"]["code"]) == ("rejected", "rate_limited")


def test_any_of_several_triggers_fires(world):
    tasks, _, _, _ = world
    routine = _automation(tasks, routineTriggers=[
        {"kind": "task_event", "on": "status_changed", "filters": {"toStatus": "done"}}, ON_BLOCKED])
    _block(tasks)
    assert run(world) == 1
    assert len(_occurrences(tasks, routine["id"])) == 1


def test_duplicate_triggers_mark_pending_once(world):
    tasks, automations, service, clock = world
    routine = _automation(tasks, routineTriggers=[ON_BLOCKED, ON_BLOCKED])
    _block(tasks)
    service.matcher.drain(clock.value)
    assert len(automations.get_state(routine["id"])["pending_events"]) == 1


def test_schedule_fires_do_not_count_toward_rate_cap(world):
    tasks, automations, service, clock = world
    routine = _automation(tasks, routineTriggers=[{"kind": "schedule", "schedule": {
        "timezone": "UTC", "repeat": {"every": "hour", "minute": 0}}}])
    for _ in range(7):
        automations.mark_pending(routine["id"], {"eventType": "schedule", "summary": "Hourly", "depth": 0}, clock.value)
        assert run(world) == 1
        for occurrence in _occurrences(tasks, routine["id"]):
            tasks.update_task(occurrence["id"], {"status": "done"})
        clock.value += timedelta(minutes=1)
    assert tasks.get_task(routine["id"])["routineState"] == "active"


def test_event_fires_still_hit_the_rate_cap(world):
    tasks, _, _, clock = world
    routine = _automation(tasks)
    for index in range(7):
        _block(tasks, f"t{index}")
        run(world)
        for occurrence in _occurrences(tasks, routine["id"]):
            tasks.update_task(occurrence["id"], {"status": "done"})
        clock.value += timedelta(minutes=1)
    task = tasks.get_task(routine["id"])
    assert (task["routineState"], task["routinePauseReason"]) == ("paused_by_relay", "rate_limited")


def test_missing_target_pauses_with_no_target(world):
    tasks, _, _, _ = world
    routine = _automation(tasks, assignedAgent=None, assignedAgentId=None)
    _block(tasks)
    assert run(world) == 0
    task = tasks.get_task(routine["id"])
    assert (task["routineState"], task["routinePauseReason"]) == ("paused_by_relay", "no_target")


def test_run_now_fires_while_paused_by_owner(world):
    tasks, automations, _, _ = world
    routine = _automation(tasks, routineState="paused")
    automations.enqueue_manual(routine["id"])
    assert run(world) == 1
    assert tasks.get_task(routine["id"])["routineState"] == "paused"


def test_run_now_ignored_when_rate_limited(world):
    tasks, automations, _, _ = world
    routine = _automation(tasks, routineState="paused_by_relay", routinePauseReason="rate_limited")
    automations.enqueue_manual(routine["id"])
    assert run(world) == 0
    assert _occurrences(tasks, routine["id"]) == []


def test_run_now_without_target_pauses(world):
    tasks, automations, _, _ = world
    routine = _automation(tasks, assignedAgent=None, assignedAgentId=None)
    automations.enqueue_manual(routine["id"])
    assert run(world) == 0
    assert tasks.get_task(routine["id"])["routinePauseReason"] == "no_target"


def test_schedule_occurrence_is_stamped_schedule(world):
    tasks, automations, _, clock = world
    routine = _automation(tasks, routineTriggers=[])
    automations.mark_pending(routine["id"], {"eventType": "schedule", "summary": "Daily at 09:00 (UTC)", "depth": 0}, clock.value)
    run(world)
    [occurrence] = _occurrences(tasks, routine["id"])
    assert occurrence["routineTriggerKind"] == "schedule"
    assert "Fired by: Schedule" in occurrence["description"]


@pytest.mark.parametrize("state, reason", [("paused", None), ("paused_by_relay", "failing"),
                                           ("paused_by_relay", "no_target"), ("paused_by_relay", "invalid_schedule")])
def test_run_now_without_target_leaves_a_paused_state_alone(world, state, reason):
    tasks, automations, _, _ = world
    routine = _automation(tasks, assignedAgent=None, assignedAgentId=None, routineState=state,
                          **({"routinePauseReason": reason} if reason else {}))
    automations.enqueue_manual(routine["id"])
    assert run(world) == 0
    after = tasks.get_task(routine["id"])
    assert (after["routineState"], after.get("routinePauseReason")) == (state, reason)
    assert _occurrences(tasks, routine["id"]) == []
    assert automations.list_pending_states() == []
    assert any(item["message"] == "Run now could not start: the automation has no agent, team, or open project."
               for item in after.get("activity", []))


def test_bad_trigger_does_not_silence_the_automations_valid_one(world) -> None:
    tasks, _, _, _ = world
    routine = _automation(tasks, routineTriggers=[
        {"kind": "task_event", "on": "status_changed", "filters": {"titleContains": 42}}, ON_BLOCKED])
    _block(tasks)
    assert run(world) == 1
    assert len(_occurrences(tasks, routine["id"])) == 1


def test_run_now_request_without_target_is_rejected_up_front(world) -> None:
    from types import SimpleNamespace
    from relay.automations.service import request_manual_occurrence
    tasks, automations, service, _ = world
    routine = _automation(tasks, assignedAgent=None, assignedAgentId=None)
    ctx = SimpleNamespace(task_store=tasks, session_store=service.matcher.session_store, project_store=None)
    result = request_manual_occurrence(automations, ctx, routine, {"isAdmin": True})
    assert result == {"task": routine, "session": None, "dispatch": {
        "state": "rejected", "code": "no_target",
        "message": "Assign an agent, team, or open project before running this automation."}}
    assert automations.list_pending_states() == []
    assert tasks.get_task(routine["id"])["routineState"] == "active"
