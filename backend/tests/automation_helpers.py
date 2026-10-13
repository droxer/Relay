"""Shortcuts for tests that need an automation occurrence but are not
testing how automations fire."""


def fire_now(task_store, routine_id, *, run_date="2026-10-13", kind="schedule"):
    return task_store.create_triggered_occurrence(
        routine_id, run_date=run_date, trigger_kind=kind, depth=0, context="", summary=None, allow_paused=True)


def schedule_trigger(repeat, timezone="UTC"):
    return {"kind": "schedule", "schedule": {"timezone": timezone, "repeat": repeat}}


DAILY_TRIGGERS = [schedule_trigger({"every": "day", "at": "09:00"})]
WEEKLY_TRIGGERS = [schedule_trigger({"every": "week", "at": "09:00", "days": [4]})]


def active_routine(triggers=None):
    """The v2 routine fields of an active automation for a ``POST /tasks`` body."""
    return {"isRoutine": True, "routineState": "active",
            "routineTriggers": WEEKLY_TRIGGERS if triggers is None else triggers}


def paused_routine(triggers=None):
    return {**active_routine(triggers), "routineState": "paused"}
