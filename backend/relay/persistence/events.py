"""Constructors for the session, task, and daemon events every store appends."""

from __future__ import annotations

from typing import Any

from ..core.ids import new_database_id, now_iso


def relay_event(
    event_type: str, session_id: str, payload: dict[str, Any]
) -> dict[str, Any]:
    return {
        "id": new_database_id(),
        "type": event_type,
        "sessionId": session_id,
        "timestamp": now_iso(),
        **payload,
    }


def relay_task_event(
    event_type: str, task_id: str, payload: dict[str, Any]
) -> dict[str, Any]:
    return {
        "id": new_database_id(),
        "type": event_type,
        "taskId": task_id,
        "timestamp": now_iso(),
        **payload,
    }


def daemon_event(event_type: str, payload: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": new_database_id(),
        "type": event_type,
        "timestamp": now_iso(),
        **payload,
    }
