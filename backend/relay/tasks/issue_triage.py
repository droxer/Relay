"""An issue outside a project is intake, not work.

A backlog task that belongs to no project has nowhere to run: a project is what
names the computer, the workspace, and the crew. Such an issue may be written,
prioritised, and handed to a person, but no agent or team may take it and it
can never be dispatched until triage moves it into a project.

Routines and the occurrences they promote are exempt — a routine names its own
agent or team and is scheduled, never triaged.

This module is the one seam for that rule. Admission (create, update,
assignment, pickup, start) refuses with ``ISSUE_NEEDS_PROJECT``; dispatch and
pickup candidates are filtered with ``issue_needs_project`` so legacy
projectless work that is already Ready is held rather than run. It stays free
of HTTP types because the task stores filter with it too.
"""

from __future__ import annotations

from typing import Any

ISSUE_NEEDS_PROJECT = "issue_needs_project"


def issue_needs_project(task: dict[str, Any]) -> bool:
    return not (
        task.get("projectId") or task.get("isRoutine") or task.get("sourceRoutineId")
    )


def project_move_error(task: dict[str, Any]) -> str | None:
    """Why ``task`` cannot be moved into a project, or ``None`` if it can.

    A project's workspace is chosen at dispatch, so only an issue that has
    never run may join one: moving live or finished work would strand its
    thread in the old workspace. Legacy projectless work that was already
    Ready is held by dispatch, so it must stay movable too.
    """
    if task.get("projectId"):
        return "task_already_in_project"
    if task.get("isRoutine") or task.get("sourceRoutineId"):
        return "routine_project_immutable"
    if task.get("status") not in ("backlog", "assigned", "blocked") or task.get(
        "linkedSessionIds"
    ):
        return "task_already_started"
    return None
