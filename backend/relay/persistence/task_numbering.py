"""Human-facing task numbers, counted per scope.

A project counts its own issues; an employee counts their issues outside any
project and, separately, their automations (rendered ``AUTO-<n>``). The number
travels on the event that fixes the scope -- ``task.created``, or
``task.project_set`` when an intake issue joins a project and takes that
project's next number -- so a replay of the log reproduces it.
``task.numbered`` exists only for the backfill of tasks created before numbers.

Numbers are never reused: each scope draws from a counter that only climbs,
so a number left behind by a deleted or moved task stays spent.
"""

from __future__ import annotations

from collections.abc import Callable
from typing import Any

NUMBERED_EVENT = "task.numbered"


def task_number_scope(task: dict[str, Any]) -> str:
    """The counter ``task`` draws from; accepts a task or a created payload."""
    owner = task.get("ownerEmployeeId") or ""
    if task.get("isRoutine"):
        return f"automation:{owner}"
    if task.get("projectId"):
        return f"project:{task['projectId']}"
    return f"issue:{owner}"


def _scope_for_event(event: dict[str, Any]) -> str | None:
    if event.get("number") is not None:
        return None
    if event.get("type") == "task.created":
        return task_number_scope(event)
    if event.get("type") == "task.project_set":
        return f"project:{event['projectId']}"
    return None


def number_task_events(
    events: list[dict[str, Any]], next_number: Callable[[str], int]
) -> list[dict[str, Any]]:
    """Return ``events`` with a number on each event that fixes a scope."""
    numbered = []
    for event in events:
        scope = _scope_for_event(event)
        numbered.append(
            event
            if scope is None
            else {**event, "number": next_number(scope), "numberScope": scope}
        )
    return numbered


def apply_task_number(task: dict[str, Any], event: dict[str, Any]) -> None:
    """Fold an event's number into a materializing task, if it carries one."""
    if event.get("number") is not None:
        task["number"] = int(event["number"])
        task["numberScope"] = event["numberScope"]
