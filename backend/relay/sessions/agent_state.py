"""The agent state a run carries between its steps."""

from __future__ import annotations

from typing import Any


def initial_agent_state(task_goal: str) -> dict[str, Any]:
    return {
        "task_goal": task_goal,
        "agent_logs": [],
        "last_exit_code": 0,
        "agent_failures": {},
    }


def merge_agent_state(state: dict[str, Any], patch: dict[str, Any]) -> dict[str, Any]:
    return {
        **state,
        **patch,
        "agent_logs": [*state.get("agent_logs", []), *patch.get("agent_logs", [])],
        "agent_failures": {
            **state.get("agent_failures", {}),
            **patch.get("agent_failures", {}),
        },
    }
