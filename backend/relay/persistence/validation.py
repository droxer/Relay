"""Field coercion and validation shared by the stores."""

from __future__ import annotations

from typing import Any

from ..core.models import AGENT_NAMES, AgentName, TaskPriority, TaskStatus


def safe_name(value: str) -> str:
    safe = "".join(ch if ch.isalnum() or ch in "._-" else "_" for ch in value)
    return safe or "relay"


def valid_agent(value: Any) -> AgentName | None:
    return value if value in AGENT_NAMES else None


def task_priority(value: Any) -> TaskPriority | None:
    return value if value in ("low", "normal", "high") else None


def task_status(value: Any) -> TaskStatus | None:
    return (
        value
        if value
        in (
            "backlog",
            "assigned",
            "running",
            "waiting_for_human",
            "review",
            "done",
            "blocked",
        )
        else None
    )
