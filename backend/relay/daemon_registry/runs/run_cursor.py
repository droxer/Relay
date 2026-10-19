"""The run request's cursor: which assignment runs now, and its live command.

A collaboration round walks its assignments one turn at a time. Between turns
the cursor names the next assignment and holds no command, run, or agent; a
turn's delivery fills those in again. Every transition that moves the cursor
writes the same cleared fields through here, so no path leaves a stale command
id behind.
"""

from __future__ import annotations

from types import MappingProxyType
from typing import Any

CLEARED_RUN_CURSOR = MappingProxyType(
    {
        "currentCommandId": None,
        "currentRunId": None,
        "currentAgent": None,
        "currentStartedAt": None,
        "currentProgressAt": None,
    }
)


def advanced_run_cursor(next_index: int, state: dict[str, Any]) -> dict[str, Any]:
    """The run-request patch that moves a running round to ``next_index``."""
    return {"status": "running", "currentIndex": next_index, "state": state, **CLEARED_RUN_CURSOR}
