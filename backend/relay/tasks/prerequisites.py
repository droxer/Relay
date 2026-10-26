"""Task prerequisites: which tasks must be done before a task may run.

A prerequisite is a task in the same project. The whole set rides one
``task.prerequisites_set`` event on the dependent task, so a replay is
idempotent. "Waiting on" is derived from the prerequisites' statuses on
read and at dispatch; it is never a task status, and no agent maintains it.

Pure rules: the task store validates a set with them under its write lock.
"""

from __future__ import annotations

from collections.abc import Iterable, Mapping
from typing import Any

PREREQUISITES_EVENT = "task.prerequisites_set"
PREREQUISITES_MAX = 10
# Only a done prerequisite releases its dependents. A deleted or unknown one
# counts as satisfied, so nothing can wait on work that no longer exists.
SATISFIED_STATUS = "done"


class PrerequisiteError(ValueError):
    def __init__(self, code: str, *, status: int = 409):
        self.code = code
        self.status = status
        super().__init__(code)


def prerequisite_ids(raw: Any) -> list[str]:
    """The ids a request names, in order and without repeats."""
    if not isinstance(raw, list) or not all(isinstance(item, str) for item in raw):
        raise PrerequisiteError("task_prerequisites_invalid", status=400)
    ids = list(dict.fromkeys(item.strip() for item in raw if item.strip()))
    if len(ids) > PREREQUISITES_MAX:
        raise PrerequisiteError("task_prerequisites_too_many", status=400)
    return ids


def validate_prerequisites(
    task: Mapping[str, Any],
    ids: list[str],
    project_tasks: Mapping[str, Mapping[str, Any]],
    edges: Mapping[str, Iterable[str]],
) -> None:
    """Refuse a set the scheduler could not honour.

    ``project_tasks`` maps every live task in the task's project to its
    snapshot fields (at least ``isRoutine``); ``edges`` maps a task id to its
    current prerequisite ids within that project.
    """
    if len(ids) > PREREQUISITES_MAX:
        raise PrerequisiteError("task_prerequisites_too_many", status=400)
    if not ids:
        return
    if task.get("isRoutine"):
        raise PrerequisiteError("task_prerequisites_routine", status=400)
    if not task.get("projectId"):
        raise PrerequisiteError("task_prerequisite_scope")
    task_id = task["id"]
    if task_id in ids:
        raise PrerequisiteError("task_prerequisite_self", status=400)
    for prerequisite_id in ids:
        prerequisite = project_tasks.get(prerequisite_id)
        if prerequisite is None:
            raise PrerequisiteError("task_prerequisite_scope")
        if prerequisite.get("isRoutine"):
            raise PrerequisiteError("task_prerequisites_routine", status=400)
    graph = {key: list(value) for key, value in edges.items()}
    graph[task_id] = list(ids)
    if _reaches(graph, ids, task_id):
        raise PrerequisiteError("task_prerequisite_cycle")


def _reaches(graph: Mapping[str, list[str]], starts: list[str], target: str) -> bool:
    seen: set[str] = set()
    stack = list(starts)
    while stack:
        current = stack.pop()
        if current == target:
            return True
        if current in seen:
            continue
        seen.add(current)
        stack.extend(graph.get(current, ()))
    return False


def open_prerequisites(
    ids: Iterable[str], statuses: Mapping[str, str | None]
) -> list[str]:
    """The prerequisites still in the way: present and not done."""
    return [
        prerequisite_id
        for prerequisite_id in ids
        if prerequisite_id in statuses and statuses[prerequisite_id] != SATISFIED_STATUS
    ]


def apply_prerequisites_set(task: dict[str, Any], event: Mapping[str, Any]) -> None:
    """Reducer step: replace the set (an empty set clears it)."""
    ids = [item for item in event.get("prerequisiteTaskIds") or [] if isinstance(item, str)]
    if ids:
        task["prerequisiteTaskIds"] = ids
    else:
        task.pop("prerequisiteTaskIds", None)
