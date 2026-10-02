"""What starts an automation, and whether an event is one of its starts.

An automation is still a routine task record; ``routineTrigger`` on it says
what fires it. Everything here is pure so the API, the store replay, and the
matcher read a trigger the same way.
"""

from __future__ import annotations

import json
from typing import Any

TRIGGER_KINDS = ("schedule", "task_event", "run_event", "webhook", "manual")
EVENT_KINDS = ("task_event", "run_event")
TRIGGER_ON = {
    "task_event": ("created", "status_changed"),
    "run_event": ("completed", "failed"),
}
EVENT_TYPES = {
    ("task_event", "created"): "task.created",
    ("task_event", "status_changed"): "task.status_changed",
    ("run_event", "completed"): "run.completed",
    ("run_event", "failed"): "run.failed",
}
SCHEDULE_TRIGGER: dict[str, Any] = {"kind": "schedule"}
SCOPE_FILTERS = ("projectId", "assignedAgentId", "assignedTeamId")
FILTER_KEYS = (*SCOPE_FILTERS, "fromStatus", "toStatus", "priority", "titleContains")
TASK_STATUSES = ("backlog", "assigned", "running", "waiting_for_human", "review", "done", "blocked")
TASK_PRIORITIES = ("low", "normal", "high")
TITLE_CONTAINS_MAX = 120
ID_MAX = 200
WEBHOOK_PAYLOAD_LIMIT = 8 * 1024
EVENT_LABELS = {
    "task.created": "Task created",
    "task.status_changed": "Task status changed",
    "run.completed": "Run completed",
    "run.failed": "Run failed",
    "webhook": "Webhook",
}


class TriggerError(ValueError):
    """A trigger the API refuses with a 400."""


def normalize_trigger(raw: Any) -> dict[str, Any]:
    if not isinstance(raw, dict):
        raise TriggerError("routineTrigger must be an object.")
    unknown = set(raw) - {"kind", "on", "filters"}
    if unknown:
        raise TriggerError(f"routineTrigger has unknown keys: {', '.join(sorted(unknown))}.")
    kind = raw.get("kind")
    if kind not in TRIGGER_KINDS:
        raise TriggerError(f"routineTrigger.kind must be one of: {', '.join(TRIGGER_KINDS)}.")
    if kind not in TRIGGER_ON:
        if raw.get("on") is not None or raw.get("filters"):
            raise TriggerError(f"A {kind} trigger takes no on or filters.")
        return {"kind": kind}
    on = raw.get("on")
    if on not in TRIGGER_ON[kind]:
        raise TriggerError(f"routineTrigger.on for {kind} must be one of: {', '.join(TRIGGER_ON[kind])}.")
    filters = _normalize_filters(on, raw.get("filters") or {})
    return {"kind": kind, "on": on, **({"filters": filters} if filters else {})}


def _normalize_filters(on: str, raw: Any) -> dict[str, str]:
    if not isinstance(raw, dict):
        raise TriggerError("routineTrigger.filters must be an object.")
    unknown = set(raw) - set(FILTER_KEYS)
    if unknown:
        raise TriggerError(f"routineTrigger.filters has unknown keys: {', '.join(sorted(unknown))}.")
    present = {key: value for key, value in raw.items() if value not in (None, "")}
    if ("fromStatus" in present or "toStatus" in present) and on != "status_changed":
        raise TriggerError("fromStatus and toStatus apply only to status_changed.")
    filters: dict[str, str] = {}
    for key, value in present.items():
        if key in SCOPE_FILTERS:
            if not isinstance(value, str) or len(value) > ID_MAX:
                raise TriggerError(f"filters.{key} must be an id.")
            filters[key] = value
        elif key in ("fromStatus", "toStatus"):
            if value not in TASK_STATUSES:
                raise TriggerError(f"filters.{key} must be a task status.")
            filters[key] = value
        elif key == "priority":
            if value not in TASK_PRIORITIES:
                raise TriggerError("filters.priority must be low, normal, or high.")
            filters[key] = value
        else:
            title = value.strip() if isinstance(value, str) else ""
            if not title or len(value) > TITLE_CONTAINS_MAX:
                raise TriggerError(f"filters.titleContains must be 1–{TITLE_CONTAINS_MAX} characters.")
            filters[key] = title
    return filters


def trigger_of(task: dict[str, Any]) -> dict[str, Any]:
    trigger = task.get("routineTrigger")
    if isinstance(trigger, dict) and trigger.get("kind") in TRIGGER_KINDS:
        return trigger
    return SCHEDULE_TRIGGER


def trigger_kind(task: dict[str, Any]) -> str:
    return str(trigger_of(task)["kind"])


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


def trigger_context_block(events: list[dict[str, Any]], dropped: int = 0) -> str:
    label = EVENT_LABELS.get(events[0]["eventType"], events[0]["eventType"])
    total = len(events) + dropped
    if total > 1:
        label = f"{label} ({total} events" + (f", {dropped} not listed" if dropped else "") + ")"
    lines = ["---", "Trigger context", f"Fired by: {label}"]
    lines.extend(f"- {_event_line(event)}" for event in events)
    return "\n".join(lines)


def _event_line(event: dict[str, Any]) -> str:
    subject = event.get("subject") or {}
    task = f'Task {subject["id"]} "{subject.get("title", "")}"' if subject.get("id") else ""
    event_type = event["eventType"]
    if event_type == "task.status_changed":
        return f"{task} — {event.get('fromStatus')} → {event.get('toStatus')}"
    if event_type == "task.created":
        return f"{task} — created"
    if event_type in ("run.completed", "run.failed"):
        outcome = "completed" if event_type == "run.completed" else "failed"
        where = task or f"Thread {event.get('sessionId')}"
        detail = f": {event['error']}" if event.get("error") else ""
        return f"{where} — run {outcome}{detail}"
    payload = json.dumps(event.get("payload"), ensure_ascii=False, sort_keys=True)
    encoded = payload.encode()
    if len(encoded) > WEBHOOK_PAYLOAD_LIMIT:
        payload = encoded[:WEBHOOK_PAYLOAD_LIMIT].decode(errors="ignore") + " …(truncated)"
    return f"Webhook payload (JSON):\n{payload}"
