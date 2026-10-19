from __future__ import annotations

from collections.abc import Iterator
from contextlib import contextmanager
from datetime import date
from typing import Any

from fastapi import HTTPException

from ...automations.model import public_task_result, without_legacy_fields
from ...collaboration.awaiting import with_awaiting
from ...tasks.issue_triage import project_move_error
from ...tasks.requests import (
    TaskRequestError,
    TaskRequestReader,
    parse_routine_fields,
)
from ...tasks.workspace import task_artifacts_dir
from ..bodies import assignment_list, participants_for_assignments, string_field
from ..deps import AppContextDep
from ..projects.access import project_for_owner
from ..schemas import TaskPatchBody


def public_task(task: dict[str, Any]) -> dict[str, Any]:
    """A task as the API answers it: legacy routine keys removed, the wait it
    is parked on projected once (`awaiting`) so no client re-derives it, and
    the folder its deliverables live in (`workspaceArtifactsDir`, null when
    the workspace itself is that folder)."""
    return {
        **with_awaiting(without_legacy_fields(task)),
        "workspaceArtifactsDir": task_artifacts_dir(task),
    }


def public_task_envelope(result: Any) -> Any:
    """`public_task` for a route answer that is a task or carries one."""
    public = public_task_result(result)
    if not isinstance(public, dict):
        return public
    if isinstance(public.get("task"), dict):
        return {**public, "task": with_awaiting(public["task"])}
    if "id" in public and "status" in public:
        return with_awaiting(public)
    return public


@contextmanager
def task_request_errors() -> Iterator[None]:
    """Answer a task service's refusal with the status and detail it carries."""
    try:
        yield
    except TaskRequestError as error:
        raise HTTPException(error.status, error.detail) from error


def date_field(body: dict[str, Any], key: str) -> str | None:
    if key not in body:
        return None
    raw = body.get(key)
    if raw in (None, ""):
        return ""
    if not isinstance(raw, str):
        raise TaskRequestError(400, f"{key} must be a YYYY-MM-DD date.")
    value = raw.strip()
    try:
        date.fromisoformat(value)
    except ValueError:
        raise TaskRequestError(400, f"{key} must be a YYYY-MM-DD date.") from None
    return value


def routine_fields(body: dict[str, Any], *, current: dict[str, Any] | None) -> dict[str, Any]:
    return parse_routine_fields(body, current=current)


def request_reader() -> TaskRequestReader:
    """How the task services read this module's request fields."""
    return TaskRequestReader(
        string=string_field,
        date=date_field,
        routine=routine_fields,
        assignments=assignment_list,
        participants=participants_for_assignments,
    )


def project_move_target(
    ctx: AppContextDep, current: dict[str, Any], body: TaskPatchBody
) -> dict[str, Any] | None:
    """The project a PATCH moves an intake issue into, if it moves one."""
    if not body.is_set("project_id"):
        return None
    project_id = body.project_id
    if not project_id:
        raise HTTPException(400, "projectId cannot be cleared.")
    if code := project_move_error(current):
        raise HTTPException(409, code)
    return project_for_owner(
        ctx, project_id, current.get("ownerUserId"), require_enabled=True
    )
