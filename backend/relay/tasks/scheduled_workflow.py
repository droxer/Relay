"""Scheduler entry into the Project workflow runtime.

A workflow Team's Task — assigned work the scheduler picks up, or an
Automation occurrence — takes the same path as a manual start
(`dispatch_task_workflow`), so the frozen ledger, gates, and recovery never
depend on who started the run. The scheduler acts for the Task's owner, the
only person a workflow Team admits.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from ..core.team_workflows import is_workflow_team
from ..security.actor import Actor
from .dispatch_outcome import DispatchResult
from .workflow import dispatch_task_workflow


@dataclass(frozen=True)
class ScheduledWorkflowContext:
    """The stores `dispatch_task_workflow` reads, gathered from the scheduler's."""

    task_store: Any
    team_store: Any
    project_store: Any
    agent_store: Any
    agent_placement_store: Any
    registry: Any


def workflow_team_for(task: dict[str, Any], team_store: Any | None) -> dict[str, Any] | None:
    """The task's workflow Team, when its assigned Team is one."""
    team_id = task.get("assignedTeamId")
    if not team_id or team_store is None or not task.get("projectId"):
        return None
    team = team_store.get_team(team_id)
    return team if team and is_workflow_team(team) else None


def dispatch_scheduled_workflow(
    ctx: ScheduledWorkflowContext, task: dict[str, Any],
) -> DispatchResult:
    actor: Actor = {"userId": task.get("ownerUserId") or "", "isAdmin": False}
    return dispatch_task_workflow(ctx, task, actor, record_pending=True)  # type: ignore[arg-type]
