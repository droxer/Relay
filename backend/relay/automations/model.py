"""What starts an automation, and whether an event is one of its starts.

An automation is still a routine task record; ``routineTriggers`` on it says
what fires it (an empty list: Run now only) and ``routineState`` whether it
may fire. Everything here is pure so the API, the store replay, and the
matcher read a trigger the same way. The legacy single ``routineTrigger`` and
cadence fields survive only as ``upgrade_legacy`` input.
"""

from __future__ import annotations

from datetime import date
from typing import Any

from .schedule import ScheduleError, normalize_schedule

TRIGGER_KINDS = ("schedule", "task_event", "run_event", "webhook")
EVENT_KINDS = ("task_event", "run_event")
TRIGGER_ON = {
    "task_event": ("created", "status_changed"),
    "run_event": ("completed", "failed"),
}
EVENT_TYPES: dict[tuple[str | None, str | None], str] = {
    ("task_event", "created"): "task.created",
    ("task_event", "status_changed"): "task.status_changed",
    ("run_event", "completed"): "run.completed",
    ("run_event", "failed"): "run.failed",
}
SCOPE_FILTERS = ("projectId", "assignedAgentId", "assignedTeamId")
FILTER_KEYS = (*SCOPE_FILTERS, "fromStatus", "toStatus", "priority", "titleContains")
TASK_STATUSES = ("backlog", "assigned", "running", "waiting_for_human", "review", "done", "blocked")
TASK_PRIORITIES = ("low", "normal", "high")
TITLE_CONTAINS_MAX = 120
ID_MAX = 200


class TriggerError(ValueError):
    """A trigger the API refuses with a 400."""


def _normalize_event_trigger(raw: dict[str, Any], at: str) -> dict[str, Any]:
    """An event or webhook trigger; ``at`` names it in error messages."""
    unknown = set(raw) - {"kind", "on", "filters"}
    if unknown:
        raise TriggerError(f"{at} has unknown keys: {', '.join(sorted(unknown))}.")
    kind = raw["kind"]
    if kind not in TRIGGER_ON:
        if raw.get("on") is not None or raw.get("filters"):
            raise TriggerError(f"{at} {kind} trigger takes no on or filters.")
        return {"kind": kind}
    on = raw.get("on")
    if on not in TRIGGER_ON[kind]:
        raise TriggerError(f"{at}.on for {kind} must be one of: {', '.join(TRIGGER_ON[kind])}.")
    filters = _normalize_filters(on, raw.get("filters") or {}, f"{at}.filters")
    return {"kind": kind, "on": on, **({"filters": filters} if filters else {})}


def _normalize_filters(on: str, raw: Any, at: str) -> dict[str, str]:
    if not isinstance(raw, dict):
        raise TriggerError(f"{at} must be an object.")
    unknown = set(raw) - set(FILTER_KEYS)
    if unknown:
        raise TriggerError(f"{at} has unknown keys: {', '.join(sorted(unknown))}.")
    present = {key: value for key, value in raw.items() if value not in (None, "")}
    if ("fromStatus" in present or "toStatus" in present) and on != "status_changed":
        raise TriggerError(f"{at}: fromStatus and toStatus apply only to status_changed.")
    filters: dict[str, str] = {}
    for key, value in present.items():
        if key in SCOPE_FILTERS:
            if not isinstance(value, str) or len(value) > ID_MAX:
                raise TriggerError(f"{at}.{key} must be an id.")
            filters[key] = value
        elif key in ("fromStatus", "toStatus"):
            if value not in TASK_STATUSES:
                raise TriggerError(f"{at}.{key} must be a task status.")
            filters[key] = value
        elif key == "priority":
            if value not in TASK_PRIORITIES:
                raise TriggerError(f"{at}.priority must be low, normal, or high.")
            filters[key] = value
        else:
            title = value.strip() if isinstance(value, str) else ""
            if not title or len(value) > TITLE_CONTAINS_MAX:
                raise TriggerError(f"{at}.titleContains must be 1–{TITLE_CONTAINS_MAX} characters.")
            filters[key] = title
    return filters


def event_matches(trigger: dict[str, Any], event: dict[str, Any]) -> bool:
    expected = EVENT_TYPES.get((trigger.get("kind"), trigger.get("on")))
    if expected is None or expected != event.get("eventType"):
        return False
    filters = trigger.get("filters") or {}
    subject = event.get("subject") or {}
    for key in (*SCOPE_FILTERS, "priority"):
        if key in filters and subject.get(key) != filters[key]:
            return False
    if "fromStatus" in filters and event.get("fromStatus") != filters["fromStatus"]:
        return False
    if "toStatus" in filters and event.get("toStatus") != filters["toStatus"]:
        return False
    title = filters.get("titleContains")
    return not title or title.lower() in str(subject.get("title") or "").lower()


MAX_TRIGGERS = 5
STATES = ("active", "paused", "paused_by_relay")
PAUSE_REASONS = ("rate_limited", "failing", "no_target", "invalid_schedule")
LEGACY_FIELDS = ("routineType", "routineCadence", "routineNextRunDate", "routineEnabled",
                 "routineDisabledReason", "routineTrigger")


def normalize_triggers(raw: Any) -> list[dict[str, Any]]:
    if not isinstance(raw, list):
        raise TriggerError("routineTriggers must be a list.")
    if len(raw) > MAX_TRIGGERS:
        raise TriggerError(f"routineTriggers may hold at most {MAX_TRIGGERS} triggers.")
    triggers = []
    for index, item in enumerate(raw):
        at = f"routineTriggers[{index}]"
        try:
            triggers.append(_normalize_one(item, at))
        except ScheduleError as error:
            # Schedule messages name their path from ``schedule.`` down.
            raise TriggerError(f"{at}.{error}") from error
    if sum(1 for trigger in triggers if trigger["kind"] == "webhook") > 1:
        raise TriggerError("routineTriggers may hold only one webhook trigger.")
    return triggers


def _normalize_one(item: Any, at: str) -> dict[str, Any]:
    if not isinstance(item, dict) or item.get("kind") not in TRIGGER_KINDS:
        raise TriggerError(f"{at}.kind must be one of: {', '.join(TRIGGER_KINDS)}.")
    if item["kind"] != "schedule":
        return _normalize_event_trigger(item, at)
    if "schedule" not in item or set(item) - {"kind", "schedule"}:
        raise TriggerError(f"{at}.schedule is required and is the only other key of a schedule trigger.")
    return {"kind": "schedule", "schedule": normalize_schedule(item["schedule"])}


def triggers_of(task: dict[str, Any]) -> list[dict[str, Any]]:
    triggers = task.get("routineTriggers")
    return [trigger for trigger in triggers if isinstance(trigger, dict)] if isinstance(triggers, list) else []


def schedule_triggers(task: dict[str, Any]) -> list[dict[str, Any]]:
    return [trigger for trigger in triggers_of(task) if trigger.get("kind") == "schedule"]


def listens(task: dict[str, Any]) -> bool:
    return any(trigger.get("kind") != "schedule" for trigger in triggers_of(task))


def has_webhook(task: dict[str, Any]) -> bool:
    return any(trigger.get("kind") == "webhook" for trigger in triggers_of(task))


def state_of(task: dict[str, Any]) -> str:
    state = task.get("routineState")
    return state if state in STATES else "paused"


def is_active(task: dict[str, Any]) -> bool:
    return bool(task.get("isRoutine")) and state_of(task) == "active" and not task.get("deletedAt")


def without_legacy_fields(task: dict[str, Any]) -> dict[str, Any]:
    """The task as the API shows it. A routine whose history is still legacy
    keeps the legacy keys in its snapshot (replay needs them); responses
    carry only the v2 fields derived from them."""
    if not any(key in task for key in LEGACY_FIELDS):
        return task
    return {key: value for key, value in task.items() if key not in LEGACY_FIELDS}


def public_task_result(result: Any) -> Any:
    """A route answer that is a task, or an envelope carrying one under
    ``task``, with the legacy routine keys removed."""
    if not isinstance(result, dict):
        return result
    public = without_legacy_fields(result)
    task = public.get("task")
    if isinstance(task, dict):
        stripped = without_legacy_fields(task)
        if stripped is not task:
            public = {**public, "task": stripped}
    return public


def upgrade_legacy(legacy: dict[str, Any]) -> dict[str, Any]:
    """What a legacy routine's fields mean in v2. Pure: the server timezone
    stays ``timezone: None`` and is resolved only when a schedule is evaluated."""
    raw_trigger = legacy.get("routineTrigger")
    trigger: dict[str, Any] = raw_trigger if isinstance(raw_trigger, dict) else {"kind": "schedule"}
    if trigger.get("kind") == "schedule":
        triggers = _legacy_schedule(legacy.get("routineCadence") or "weekly", legacy.get("routineNextRunDate"))
    elif trigger.get("kind") == "manual":
        triggers = []
    else:
        triggers = [{key: value for key, value in trigger.items() if key in ("kind", "on", "filters")}]
    if legacy.get("routineEnabled"):
        state: dict[str, Any] = {"routineState": "active"}
    elif legacy.get("routineDisabledReason") == "rate_limited":
        state = {"routineState": "paused_by_relay", "routinePauseReason": "rate_limited"}
    else:
        state = {"routineState": "paused"}
    return {"routineTriggers": triggers, **state}


def _legacy_schedule(cadence: str, next_run: Any) -> list[dict[str, Any]]:
    try:
        day = date.fromisoformat(next_run) if next_run else None
    except (TypeError, ValueError):
        day = None
    if day is None:
        return []
    if cadence == "custom":
        repeat: dict[str, Any] = {"once": f"{day.isoformat()}T00:00"}
    elif cadence == "daily":
        repeat = {"every": "day", "at": "00:00"}
    elif cadence == "monthly":
        repeat = {"every": "month", "at": "00:00", "day": day.day}
    else:
        repeat = {"every": "week", "at": "00:00", "days": [day.isoweekday()]}
    return [{"kind": "schedule", "schedule": {"timezone": None, "repeat": repeat}}]
