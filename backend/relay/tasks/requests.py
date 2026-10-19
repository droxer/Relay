"""Shared vocabulary for the task services: the refusal they raise and the
request fields they read.

The services own the order in which a task request is judged; the HTTP layer
owns how a raw field is read. ``TaskRequestReader`` carries the HTTP layer's
readers in, so the services never import ``relay.api`` and every refusal
keeps its original place in the validation order.
"""
from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any

from ..automations.model import TriggerError
from ..automations.service import automation_triggers_enabled, routine_fields_v2
from ..collaboration.styles import CollaborationStyleError, validate_collaboration_style
from ..core.task_tags import normalize_tags
from ..persistence.task.rules import TaskExecutionActiveError
from .issue_triage import ISSUE_NEEDS_PROJECT, issue_needs_project

ACCEPTANCE_POLICIES = ("human", "automatic")


class TaskRequestError(Exception):
    """A task request refused, with the HTTP status and detail it answers."""

    def __init__(self, status: int, detail: Any) -> None:
        super().__init__(detail)
        self.status = status
        self.detail = detail


@dataclass(frozen=True)
class TaskRequestReader:
    """How the HTTP layer reads a task request's fields."""

    string: Callable[[dict[str, Any], str], str]
    date: Callable[[dict[str, Any], str], str | None]
    routine: Callable[..., dict[str, Any]]
    assignments: Callable[[Any], list[dict[str, Any]]]
    participants: Callable[[Any, str | None], list[str]]


def acceptance_policy_field(body: dict[str, Any]) -> Any:
    value = body.get("acceptancePolicy")
    if "acceptancePolicy" in body and value not in ACCEPTANCE_POLICIES:
        raise TaskRequestError(400, "acceptancePolicy must be human or automatic.")
    return value


def tags_field(body: dict[str, Any]) -> list[str] | None:
    """The tags a body names (``[]`` clears them), or None when it names none."""
    if "tags" not in body:
        return None
    try:
        return normalize_tags(body["tags"] if body["tags"] is not None else [])
    except ValueError as error:
        raise TaskRequestError(400, str(error)) from error


def collaboration_style_field(body: dict[str, Any], *, allow_clear: bool) -> str | None:
    value = body.get("collaborationStyle")
    if value is None:
        return None
    if allow_clear and value == "":
        return ""
    try:
        return validate_collaboration_style(value)
    except CollaborationStyleError as error:
        raise TaskRequestError(400, str(error)) from error


def parse_routine_fields(
    body: dict[str, Any], *, current: dict[str, Any] | None
) -> dict[str, Any]:
    """``routine_fields_v2`` behind the triggers switch."""
    try:
        fields = routine_fields_v2(body, current=current, now=datetime.now(UTC))
    except TriggerError as error:
        raise TaskRequestError(400, str(error)) from error
    if (
        "routineTriggers" in body
        and not automation_triggers_enabled()
        and any(trigger["kind"] != "schedule" for trigger in fields.get("routineTriggers", []))
    ):
        raise TaskRequestError(400, "Only schedule triggers are enabled on this server.")
    return fields


def ensure_issue_in_project(task: dict[str, Any]) -> None:
    """Refuse to hand intake work to an agent or team: it has nowhere to run."""
    if issue_needs_project(task):
        raise TaskRequestError(409, ISSUE_NEEDS_PROJECT)


def update_task_unless_dispatching(
    ctx: Any, task_id: str, payload: dict[str, Any]
) -> dict[str, Any]:
    try:
        return ctx.task_store.update_task_if_not_dispatching(task_id, payload)
    except TaskExecutionActiveError as error:
        raise TaskRequestError(409, "task_execution_active") from error
