"""Shortcuts for tests that need an automation occurrence but are not
testing how automations fire."""


def fire_now(task_store, routine_id, *, run_date="2026-10-13", kind="schedule"):
    # Task 11 adds allow_paused=True; until then the routine must be active.
    return task_store.create_triggered_occurrence(
        routine_id, run_date=run_date, trigger_kind=kind, depth=0, context="", summary=None)
