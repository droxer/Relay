from __future__ import annotations

import pytest
from relay.automations.context import trigger_context_block
from relay.automations.model import TriggerError, event_matches, normalize_trigger, trigger_kind


def test_schedule_and_webhook_take_no_options() -> None:
    assert normalize_trigger({"kind": "schedule"}) == {"kind": "schedule"}
    assert normalize_trigger({"kind": "webhook"}) == {"kind": "webhook"}
    with pytest.raises(TriggerError):
        normalize_trigger({"kind": "webhook", "on": "created"})


@pytest.mark.parametrize("raw", [
    None, "schedule", {"kind": "cron"}, {"kind": "task_event"},
    {"kind": "task_event", "on": "completed"},
    {"kind": "run_event", "on": "failed", "filters": {"toStatus": "done"}},
    {"kind": "task_event", "on": "created", "filters": {"fromStatus": "running"}},
    {"kind": "task_event", "on": "created", "filters": {"unknown": 1}},
    {"kind": "task_event", "on": "created", "filters": {"titleContains": "x" * 121}},
    {"kind": "task_event", "on": "status_changed", "filters": {"toStatus": "failed"}},
    {"kind": "schedule", "extra": True},
])
def test_rejects_malformed_triggers(raw) -> None:
    with pytest.raises(TriggerError):
        normalize_trigger(raw)


def test_drops_empty_filters_and_trims_title() -> None:
    assert normalize_trigger({
        "kind": "task_event", "on": "status_changed",
        "filters": {"toStatus": "blocked", "projectId": "", "titleContains": "  nightly "},
    }) == {"kind": "task_event", "on": "status_changed",
           "filters": {"toStatus": "blocked", "titleContains": "nightly"}}


def test_missing_trigger_reads_as_schedule() -> None:
    assert trigger_kind({}) == "schedule"
    assert trigger_kind({"routineTrigger": {"kind": "bogus"}}) == "schedule"
    assert trigger_kind({"routineTrigger": {"kind": "webhook"}}) == "webhook"


def _status_event(**subject) -> dict:
    return {"eventType": "task.status_changed", "fromStatus": "running", "toStatus": "blocked",
            "subject": {"id": "T-1", "title": "Nightly import", "priority": "high", **subject}, "depth": 0}


def test_event_matches_kind_on_and_every_filter() -> None:
    trigger = {"kind": "task_event", "on": "status_changed",
               "filters": {"toStatus": "blocked", "projectId": "p1", "titleContains": "IMPORT"}}
    assert event_matches(trigger, _status_event(projectId="p1"))
    assert not event_matches(trigger, _status_event(projectId="p2"))
    assert not event_matches({**trigger, "on": "created"}, _status_event(projectId="p1"))
    assert not event_matches({"kind": "webhook"}, _status_event())


def test_context_block_lists_events_and_dropped_count() -> None:
    block = trigger_context_block([_status_event(), _status_event()], dropped=1)
    assert block.splitlines()[:3] == ["---", "Trigger context", "Fired by: Task status changed (3 events, 1 not listed)"]
    assert '- Task T-1 "Nightly import" — running → blocked' in block


def test_context_block_truncates_webhook_payload() -> None:
    block = trigger_context_block([{"eventType": "webhook", "payload": {"blob": "x" * 20000}, "depth": 0}])
    assert "(truncated)" in block
    assert len(block.encode()) < 9 * 1024


import pytest
from relay.automations.model import TriggerError, listens, normalize_triggers, state_of, upgrade_legacy

DAILY = {"kind": "schedule", "schedule": {"timezone": None, "repeat": {"every": "day", "at": "09:00"}}}
BLOCKED = {"kind": "task_event", "on": "status_changed", "filters": {"toStatus": "blocked"}}


def test_normalize_list_round_trips():
    assert normalize_triggers([DAILY, BLOCKED, {"kind": "webhook"}]) == [DAILY, BLOCKED, {"kind": "webhook"}]


def test_empty_list_is_run_now_only():
    assert normalize_triggers([]) == []


@pytest.mark.parametrize("raw, message", [
    ("nope", "routineTriggers must be a list"),
    ([DAILY] * 6, "at most 5"),
    ([{"kind": "webhook"}, {"kind": "webhook"}], "one webhook"),
    ([{"kind": "manual"}], r"routineTriggers\[0\]\.kind"),
    ([DAILY, {"kind": "schedule", "schedule": {"timezone": None, "repeat": {"cron": "* * * * *"}}}],
     r"routineTriggers\[1\]\..*15 minutes"),
    ([{"kind": "schedule"}], r"routineTriggers\[0\]\.schedule"),
])
def test_invalid_lists_name_the_index(raw, message):
    with pytest.raises(TriggerError, match=message):
        normalize_triggers(raw)


def _schedule(repeat):
    return [{"kind": "schedule", "schedule": {"timezone": None, "repeat": repeat}}]


@pytest.mark.parametrize("legacy, triggers", [
    ({"routineCadence": "daily", "routineNextRunDate": "2026-10-14"}, _schedule({"every": "day", "at": "00:00"})),
    ({"routineCadence": "weekly", "routineNextRunDate": "2026-10-14"},  # a Wednesday
     _schedule({"every": "week", "at": "00:00", "days": [3]})),
    ({"routineCadence": "monthly", "routineNextRunDate": "2026-10-31"},
     _schedule({"every": "month", "at": "00:00", "day": 31})),
    ({"routineCadence": "custom", "routineNextRunDate": "2026-10-20"}, _schedule({"once": "2026-10-20T00:00"})),
    ({"routineCadence": "custom"}, []),
    ({"routineCadence": "weekly"}, []),  # unscheduled
    ({"routineTrigger": {"kind": "manual"}, "routineCadence": "weekly", "routineNextRunDate": "2026-10-14"}, []),
    ({"routineTrigger": BLOCKED}, [BLOCKED]),
    ({"routineTrigger": {"kind": "webhook"}}, [{"kind": "webhook"}]),
])
def test_upgrade_legacy_triggers(legacy, triggers):
    assert upgrade_legacy(legacy)["routineTriggers"] == triggers


@pytest.mark.parametrize("legacy, state, reason", [
    ({"routineEnabled": True}, "active", None),
    ({"routineEnabled": False}, "paused", None),
    ({}, "paused", None),
    ({"routineEnabled": False, "routineDisabledReason": "rate_limited"}, "paused_by_relay", "rate_limited"),
])
def test_upgrade_legacy_state(legacy, state, reason):
    upgraded = upgrade_legacy(legacy)
    assert upgraded["routineState"] == state
    assert upgraded.get("routinePauseReason") == reason


def test_listens_and_state_defaults():
    assert listens({"routineTriggers": [DAILY]}) is False
    assert listens({"routineTriggers": [DAILY, BLOCKED]}) is True
    assert state_of({}) == "paused"
