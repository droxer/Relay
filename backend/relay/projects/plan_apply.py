"""Applying a proposal's tasks: which ones, and what each must wait for.

A setup or plan proposal lists tasks with keys and ``after`` links. The
owner applies all of them or a chosen subset; each applied task's key is
recorded on the setup (``appliedTasks``), so a retried apply creates only
what is missing and never duplicates a task.
"""

from __future__ import annotations

from collections.abc import Collection, Mapping
from typing import Any

from .setup import ProjectSetupError

_APPLICABLE_STATES = frozenset({"proposed", "applied"})


def applicable_setup(project: Mapping[str, Any], draft_id: Any) -> dict[str, Any]:
    """The project's setup when it holds the named draft's proposed tasks."""
    setup = project.get("setup") or {}
    if not isinstance(draft_id, str) or setup.get("draftId") != draft_id:
        raise ProjectSetupError("project_setup_draft_mismatch")
    if setup.get("state") not in _APPLICABLE_STATES:
        raise ProjectSetupError("project_setup_not_proposed")
    tasks = (setup.get("proposal") or {}).get("tasks")
    if not tasks:
        raise ProjectSetupError("project_setup_no_tasks")
    # A proposal drafted before tasks had keys is addressed by position.
    keyed = [
        {**task, "key": task.get("key") or f"task-{index + 1}"}
        for index, task in enumerate(tasks)
    ]
    return {**setup, "proposal": {**setup["proposal"], "tasks": keyed}}


def selected_tasks(setup: Mapping[str, Any], keys: Any) -> list[dict[str, Any]]:
    """The proposal's tasks in proposal order, limited to ``keys`` if given."""
    tasks = list((setup.get("proposal") or {}).get("tasks") or [])
    if keys is None:
        return tasks
    if not isinstance(keys, list) or not all(isinstance(key, str) for key in keys):
        raise ProjectSetupError("project_setup_task_keys_invalid", status=400)
    known = {task.get("key") for task in tasks}
    if any(key not in known for key in keys):
        raise ProjectSetupError("project_setup_task_keys_invalid", status=400)
    return [task for task in tasks if task.get("key") in set(keys)]


def assignee_overrides(raw: Any) -> dict[str, str | None]:
    """The owner's per-key assignee choices: an agent id, or null for none."""
    if raw is None:
        return {}
    if not isinstance(raw, dict) or not all(
        isinstance(key, str) and (value is None or isinstance(value, str))
        for key, value in raw.items()
    ):
        raise ProjectSetupError("project_setup_assignees_invalid", status=400)
    return {key: value or None for key, value in raw.items()}


def task_create_body(
    task: Mapping[str, Any], project_id: str, overrides: Mapping[str, str | None]
) -> dict[str, Any]:
    """The task POST body a proposed task becomes. Always backlog: its
    prerequisites are set before anything may queue it."""
    key = str(task.get("key") or "")
    assignee = overrides[key] if key in overrides else task.get("assignedAgentId")
    return {
        "title": task["title"],
        "description": task.get("description", ""),
        "projectId": project_id,
        **({"assignedAgentId": assignee} if assignee else {}),
    }


def prerequisites_for(
    task: Mapping[str, Any],
    applied: Mapping[str, str],
    project_task_ids: Collection[str],
) -> list[str]:
    """Task ids the applied task waits for: earlier proposed tasks that were
    applied, and existing project tasks that still exist. A link to a task
    the owner left out is dropped rather than refused."""
    ids = [applied[key] for key in task.get("after") or [] if key in applied]
    ids.extend(
        task_id for task_id in task.get("afterTaskIds") or [] if task_id in project_task_ids
    )
    return list(dict.fromkeys(ids))
