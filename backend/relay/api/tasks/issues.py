"""Numbered pages for the web Issues list and board."""

from __future__ import annotations

from collections.abc import Collection
from datetime import UTC, date, datetime, timedelta
from typing import Any

from fastapi import HTTPException, Request

from ...core.issue_listing import ISSUE_GROUPS, ISSUE_LANES, ISSUE_PRIORITIES, ISSUE_QUEUES, ISSUE_SORTS, ISSUE_STATUSES, IssueListRequest
from ...security.actor import Actor
from ..deps import AppContext
from .payloads import public_task
from .prerequisites import with_dependency_summaries, with_waiting_on

# The record fetch carries the full description, activity, and execution data.
_ISSUE_FIELDS = frozenset({
    "id", "number", "title", "priority", "status", "workflowStage", "isRoutine", "tags",
    "projectId", "computerId", "ownerUserId", "assigneeUserId", "sourceRoutineId", "scheduledFor",
    "assignedAgent", "assignedAgentId", "assignedTeamId", "assignedWorkflowId", "collaborationStyle",
    "dueDate", "createdAt", "updatedAt", "startedAt", "finishedAt", "linkedSessionIds",
    "dispatchOutcome", "blockerReason", "awaiting", "workspaceBinding", "externalSource",
    "prerequisiteTaskIds", "waitingOn", "waitingOnSummaries", "eventCount", "activityCount",
})


def task_page_number(value: str) -> int:
    return max(1, int(value)) if value.isascii() and value.isdecimal() and len(value) <= 16 else 1


def read_issue_page(
    ctx: AppContext, actor: Actor, request: Request, layout: str, *, workspace_board: bool = False,
) -> dict[str, Any]:
    params = request.query_params

    def choice(key: str, values: Collection[str], default: str = "") -> str:
        value = params.get(key, default)
        return value if value in values else default

    try:
        today = date.fromisoformat(params["today"]) if "today" in params else datetime.now(UTC).date()
        if today > date.max - timedelta(days=7):
            raise ValueError
    except ValueError as error:
        raise HTTPException(400, "Invalid Issues calendar date.") from error
    lanes = {}
    for entry in params.get("lanes", "").split(","):
        lane, _, number = entry.partition(":")
        if lane in ISSUE_LANES:
            lanes[lane] = task_page_number(number)
    sort = params.get("sort", "")
    tag = params.get("tag", "")
    agent = params.get("agent", "")
    team = params.get("team", "")
    project_id = params.get("projectId", "")
    computer_id = params.get("computerId", "") if workspace_board else ""
    if "\x00" in project_id:
        raise HTTPException(400, "Invalid Project id.")
    if "\x00" in computer_id:
        raise HTTPException(400, "Invalid Computer id.")
    if workspace_board and bool(project_id) == bool(computer_id):
        raise HTTPException(400, "Specify one Project or Computer for the Task board.")
    rows, metadata = ctx.task_store.issue_page(IssueListRequest(
        owner=actor["userId"], today=today, layout=layout,
        queue=choice("queue", ISSUE_QUEUES, "open"), group=choice("group", ISSUE_GROUPS, "project"),
        project_id=project_id, sort=sort if sort.lstrip("-") in ISSUE_SORTS else "",
        computer_id=computer_id, workspace_board=workspace_board,
        status=choice("status", ISSUE_STATUSES) if workspace_board else "",
        unplaced_page=task_page_number(params.get("unplacedPage", "")),
        page=task_page_number(params.get("page", "")), lanes=lanes,
        query=params.get("q", "").strip().lower(), tag=tag.lower() if tag != "all" else "",
        priority=choice("priority", ISSUE_PRIORITIES), source="" if workspace_board else choice("source", ("direct", "routine")),
        due=choice("due", ("overdue", "today", "next_week", "unscheduled")),
        agent=agent if agent != "all" else "", team=team if team != "all" else "",
        assignee=params.get("assignee", "").strip().lower(),
        assignment=choice("assignment", ("assigned", "unassigned")),
        missing_agent=params.get("missingAgent", "Unavailable agent")[:128],
        missing_team=params.get("missingTeam", "Unavailable team")[:128],
        workflow=params.get("workflow", "Workflow")[:128],
        unassigned=params.get("unassigned", "Unassigned")[:128],
    ))
    tasks = with_dependency_summaries(ctx, actor, with_waiting_on(ctx, [public_task(task) for task in rows]))
    return {
        **metadata,
        "tasks": [{"description": "", **{key: row[key] for key in sorted(row.keys() & _ISSUE_FIELDS)}} for row in tasks],
    }
