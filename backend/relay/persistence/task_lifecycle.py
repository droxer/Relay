"""Task flow policy. Execution rounds never reset the work item's age."""

from __future__ import annotations

import os
from typing import Any

FLOW_STAGES = ("backlog", "assigned", "running", "review", "done")


def wip_limit() -> int:
    value = int(os.environ.get("RELAY_TASK_WIP_LIMIT", "5"))
    if value < 1:
        raise ValueError("RELAY_TASK_WIP_LIMIT must be a positive integer.")
    return value


def flow_scope(task: dict[str, Any]) -> str:
    return task.get("assigneeEmployeeId") or task.get("ownerEmployeeId") or "unowned"


def is_wip(task: dict[str, Any]) -> bool:
    if task.get("isRoutine") or task.get("deletedAt") or task.get("status") == "done":
        return False
    return bool(task.get("startedAt")) or task.get("status") in (
        "running",
        "review",
        "waiting_for_human",
    )


def needs_wip_admission(current: dict[str, Any], updated: dict[str, Any]) -> bool:
    """Continuations retain a slot; reopening or changing employee acquires one."""
    return is_wip(updated) and (
        not is_wip(current) or flow_scope(current) != flow_scope(updated)
    )


def check_wip_admission(task: dict[str, Any], tasks: list[dict[str, Any]]) -> None:
    count = sum(
        is_wip(item) and flow_scope(item) == flow_scope(task)
        for item in tasks
        if item["id"] != task["id"]
    )
    if count >= wip_limit():
        raise ValueError(
            "task_wip_limit: Finish existing work before starting another task."
        )


def apply_flow_status(task: dict[str, Any], event: dict[str, Any]) -> None:
    status = event["status"]
    previous = task["status"]
    stage = task.get("workflowStage", "backlog")
    if status in ("blocked", "waiting_for_human"):
        if previous != status:
            task[
                "blockedFromStatus" if status == "blocked" else "waitingFromStatus"
            ] = previous
        if status == "blocked":
            task.setdefault("blockedAt", event["timestamp"])
            task["blockerReason"] = (
                event.get("reason")
                or task.get("blockerReason")
                or "Execution needs attention."
            )
            task["blockerOwnerEmployeeId"] = event.get("actorEmployeeId") or flow_scope(
                task
            )
        # A wait after execution is still in progress; an impediment in review stays there.
        if stage not in ("backlog", "assigned", "running", "review") or (
            status == "waiting_for_human" and stage == "backlog"
        ):
            stage = "running"
    else:
        # `assigned` means the execution is queued. Admission may already have
        # reserved WIP and set startedAt, but the board must not report an
        # agent as running until the daemon emits the running status.
        stage = status
    if status != "blocked":
        for field in (
            "blockedAt",
            "blockerReason",
            "blockerOwnerEmployeeId",
            "blockedFromStatus",
        ):
            task.pop(field, None)
    if status != "waiting_for_human":
        task.pop("waitingFromStatus", None)
    if status in ("running", "review", "waiting_for_human") and not task.get(
        "isRoutine"
    ):
        task.setdefault("startedAt", event["timestamp"])
    if status == "done":
        task.setdefault("finishedAt", event["timestamp"])
    else:
        task.pop("finishedAt", None)
    task["workflowStage"] = stage


def validate_manual_transition(
    task: dict[str, Any], target: str, *, active: bool = False, unblock: bool = False
) -> None:
    current = task["status"]
    if target == current:
        return
    if active:
        raise ValueError("task_execution_active")
    if unblock:
        return  # Restores a recorded state; does not dispatch an agent.
    if target in ("running", "waiting_for_human"):
        raise ValueError("task_transition_requires_execution")
    if target == "review" and not task.get("startedAt"):
        raise ValueError("task_review_requires_work")
    if target == "done" and current != "review":
        raise ValueError("task_acceptance_requires_review")
    if target == "blocked" and current == "done":
        raise ValueError("task_reopen_required")
    if target == "backlog" and task.get("startedAt"):
        raise ValueError("task_started_cannot_return_to_backlog")
