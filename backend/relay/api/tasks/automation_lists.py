"""Numbered Automation definitions for the web lists."""

from datetime import UTC, datetime
from typing import Any

from fastapi import HTTPException, Request

from ...automations.model import TRIGGER_KINDS, triggers_of
from ...core.automation_listing import AUTOMATION_LIST_SORTS, AUTOMATION_LIST_STATES, AutomationListRequest
from ...security.actor import Actor
from ..deps import AppContext
from .issues import task_page_number


_LIST_FIELDS = frozenset({
    "id", "title", "number", "priority", "isRoutine", "status", "projectId", "computerId", "workspaceBinding",
    "ownerUserId", "assigneeUserId", "tags", "assignedAgent", "assignedAgentId", "assignedTeamId", "assignedWorkflowId",
    "collaborationStyle", "routineState", "routinePauseReason", "routineNextRunAt", "createdAt", "updatedAt", "eventCount",
})


def _list_trigger(trigger: dict[str, Any]) -> dict[str, Any]:
    if trigger["kind"] == "schedule":
        return {"kind": "schedule", "schedule": trigger["schedule"]}
    item: dict[str, Any] = {key: trigger[key] for key in ("kind", "on") if key in trigger}
    if status := (trigger.get("filters") or {}).get("toStatus"):
        item["filters"] = {"toStatus": status}
    return item


def _automation_list_item(task: dict[str, Any]) -> dict[str, Any]:
    return {
        **{key: task[key] for key in sorted(task.keys() & _LIST_FIELDS)},
        "description": "",
        "linkedSessionIds": [],
        "routineTriggers": [_list_trigger(trigger) for trigger in triggers_of(task) if trigger.get("kind") in TRIGGER_KINDS],
    }


def read_automation_page(ctx: AppContext, actor: Actor, request: Request) -> dict[str, Any]:
    params = request.query_params
    project_id = params.get("projectId", "")
    computer_id = params.get("computerId", "")
    if "\x00" in project_id or "\x00" in computer_id or (project_id and computer_id):
        raise HTTPException(400, "Invalid Automation workspace.")
    sort = params.get("sort", "")
    trigger = params.get("trigger", "")
    state = params.get("state", "")
    tag = params.get("tag", "")
    agent = params.get("agent", "")
    tasks, metadata = ctx.task_store.automation_page(AutomationListRequest(
        owner=actor["userId"], now=datetime.now(UTC), project_id=project_id, computer_id=computer_id,
        search=params.get("q", "").strip().lower(), tag=tag.lower() if tag != "all" else "",
        agent=agent if agent != "all" else "", assignee=params.get("assignee", "").strip().lower(),
        trigger=trigger if trigger in (*TRIGGER_KINDS, "none") else "",
        state=state if state in AUTOMATION_LIST_STATES else "",
        sort=sort if sort.lstrip("-") in AUTOMATION_LIST_SORTS else "",
        page=task_page_number(params.get("page", "")), unplaced_page=task_page_number(params.get("unplacedPage", "")),
        missing_agent=params.get("missingAgent", "Unavailable agent")[:128],
        missing_team=params.get("missingTeam", "Unavailable team")[:128],
        workflow=params.get("workflow", "Workflow")[:128],
        unassigned=params.get("unassigned", "Unassigned")[:128],
    ))
    return {**metadata, "tasks": [_automation_list_item(task) for task in tasks]}
