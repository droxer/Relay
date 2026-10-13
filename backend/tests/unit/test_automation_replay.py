from relay.persistence.store_common import materialize_task_events


def ev(kind, n, **payload):
    return {"id": f"e{n}", "type": kind, "taskId": "t1", "timestamp": f"2026-10-13T00:00:0{n}Z", **payload}


def created(**fields):
    return ev("task.created", 0, title="Digest", description="", isRoutine=True, **fields)


def test_legacy_stream_replays_to_v2():
    task = materialize_task_events([
        created(routineType="job", routineCadence="weekly", routineNextRunDate="2026-10-14", routineEnabled=True),
    ])
    assert task["routineTriggers"][0]["schedule"]["repeat"] == {"every": "week", "at": "00:00", "days": [3]}
    assert task["routineState"] == "active"
    assert task["routineNextRunDate"] == "2026-10-14"
    # Task 12 asserts the legacy keys are gone once the compatibility mirror is removed.


def test_legacy_update_after_legacy_create_recomputes():
    task = materialize_task_events([
        created(routineCadence="weekly", routineNextRunDate="2026-10-14", routineEnabled=True),
        ev("task.updated", 1, routineEnabled=False, routineDisabledReason="rate_limited"),
    ])
    assert (task["routineState"], task["routinePauseReason"]) == ("paused_by_relay", "rate_limited")
    assert task["routineTriggers"][0]["kind"] == "schedule"
    # routineNextRunDate is still mirrored for legacy readers until Task 12.


def test_v2_event_replaces_legacy_and_drops_retained_date():
    task = materialize_task_events([
        created(routineCadence="daily", routineNextRunDate="2026-10-14", routineEnabled=True),
        ev("task.updated", 1, routineTriggers=[{"kind": "webhook"}], routineState="paused", routineNextRunAt=None),
    ])
    assert task["routineTriggers"] == [{"kind": "webhook"}] and task["routineState"] == "paused"
    assert "routineNextRunDate" not in task and "routineNextRunAt" not in task and "_legacyRoutine" not in task
    assert "routineEnabled" not in task


def test_v2_create_with_next_run():
    task = materialize_task_events([created(routineTriggers=[], routineState="active",
                                            routineNextRunAt="2026-10-14T01:00:00+00:00")])
    assert task["routineNextRunAt"] == "2026-10-14T01:00:00+00:00"
    assert "routineEnabled" not in task


def test_resume_clears_reason():
    task = materialize_task_events([
        created(routineTriggers=[], routineState="paused_by_relay", routinePauseReason="failing"),
        ev("task.updated", 1, routineState="active"),
    ])
    assert task["routineState"] == "active" and "routinePauseReason" not in task


def test_turning_routine_off_drops_all_routine_fields():
    task = materialize_task_events([
        created(routineTriggers=[], routineState="active"),
        ev("task.updated", 1, isRoutine=False),
    ])
    stamps = {"routineTriggerKind", "routineTriggerDepth", "routineTriggerSummary"}
    assert not [key for key in task if key.startswith(("routine", "_legacy")) and key not in stamps]


def test_turning_legacy_routine_off_drops_all_routine_fields():
    task = materialize_task_events([
        created(routineCadence="daily", routineNextRunDate="2026-10-14", routineEnabled=True),
        ev("task.updated", 1, isRoutine=False),
    ])
    stamps = {"routineTriggerKind", "routineTriggerDepth", "routineTriggerSummary"}
    assert not [key for key in task if key.startswith(("routine", "_legacy")) and key not in stamps]


def test_pre_v2_snapshot_upgrades_from_its_stored_legacy_keys():
    from relay.persistence.task_store import apply_task_events

    stored = {"id": "t1", "isRoutine": True, "routineCadence": "daily",
              "routineNextRunDate": "2026-10-14", "routineEnabled": True}
    task = apply_task_events(stored, [ev("task.updated", 1, routineNextRunDate="2026-10-15", routineEnabled=True)], version=1)
    assert task["routineTriggers"][0]["schedule"]["repeat"] == {"every": "day", "at": "00:00"}
    assert task["routineState"] == "active"


def test_pre_v2_webhook_snapshot_keeps_its_trigger_when_disabled():
    from relay.persistence.task_store import apply_task_events

    stored = {"id": "t1", "isRoutine": True, "routineTrigger": {"kind": "webhook"}, "routineEnabled": True}
    task = apply_task_events(stored, [ev("task.updated", 1, routineEnabled=False)], version=1)
    assert task["routineTriggers"] == [{"kind": "webhook"}]
    assert task["routineState"] == "paused"
