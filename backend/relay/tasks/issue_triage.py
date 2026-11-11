"""Work needs a Project or an explicitly selected Computer.

Legacy issues with neither scope remain intake until placed. Automations and
occurrences keep their legacy agent-based routing when no Computer was saved.
"""

from __future__ import annotations

from typing import Any

ISSUE_NEEDS_PROJECT = "issue_needs_project"


def issue_needs_project(task: dict[str, Any]) -> bool:
    return not (
        task.get("projectId") or task.get("computerId") or task.get("isRoutine") or task.get("sourceRoutineId")
    )


def project_move_error(task: dict[str, Any]) -> str | None:
    """Why ``task`` cannot be moved into a project, or ``None`` if it can.

    A project's workspace is chosen at dispatch, so only an issue that has
    never run may join one: moving live or finished work would strand its
    thread in the old workspace. Legacy projectless work that was already
    Ready is held by dispatch, so it must stay movable too.
    """
    if task.get("computerId"):
        return "task_workspace_immutable"
    if task.get("projectId"):
        return "task_already_in_project"
    if task.get("isRoutine") or task.get("sourceRoutineId"):
        return "routine_project_immutable"
    if task.get("status") not in ("backlog", "assigned", "queued", "blocked") or task.get(
        "linkedSessionIds"
    ):
        return "task_already_started"
    return None
