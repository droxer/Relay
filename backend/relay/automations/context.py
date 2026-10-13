"""The block appended to an occurrence's description.

``web/src/lib/automationOpening.ts`` parses it, so keep them in step.
"""

from __future__ import annotations

import json
from typing import Any

WEBHOOK_PAYLOAD_LIMIT = 8 * 1024
EVENT_LABELS = {
    "task.created": "Task created",
    "task.status_changed": "Task status changed",
    "run.completed": "Run completed",
    "run.failed": "Run failed",
    "webhook": "Webhook",
    "manual": "Manual",
}


def trigger_context_block(events: list[dict[str, Any]], dropped: int = 0, *, fired_by: str | None = None) -> str:
    """``fired_by`` names the event type that started the run when it is not
    the first pending event, as with a Run now coalesced behind other events."""
    first = fired_by or events[0]["eventType"]
    label = EVENT_LABELS.get(first, first)
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
    if event_type == "manual":
        return "Run now requested."
    payload = json.dumps(event.get("payload"), ensure_ascii=False, sort_keys=True)
    encoded = payload.encode()
    if len(encoded) > WEBHOOK_PAYLOAD_LIMIT:
        payload = encoded[:WEBHOOK_PAYLOAD_LIMIT].decode(errors="ignore") + " …(truncated)"
    return f"Webhook payload (JSON):\n{payload}"
