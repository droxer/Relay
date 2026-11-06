"""The authoritative Relay MCP tool catalog and input schemas."""

from typing import Any
from mcp.types import Tool, ToolAnnotations

TOOL_OPERATIONS = {
    "relay_list_projects": "projects",
    "relay_project_overview": "overview",
    "relay_list_tasks": "tasks",
    "relay_get_task": "task",
    "relay_task_review": "review",
    "relay_project_activity": "activity",
    "relay_project_threads": "threads",
    "relay_get_thread": "thread",
    "relay_propose_task_changes": "propose",
}
_DESCRIPTIONS = {
    "projects": "List Projects this token can access.",
    "overview": "Read current Project goal, context, roster and Task counts.",
    "tasks": "List Project Tasks with status, query, cursor and limit filters.",
    "task": "Read a Task and its current revision before proposing edits.",
    "review": "Read Task review evidence.",
    "activity": "Read Project activity within an explicit time window.",
    "threads": "List Project Threads.",
    "thread": "Read a Project Thread.",
    "propose": "Stage up to 20 Task operations for owner review. Does not apply or start work.",
}
_TEXT = {"type": "string"}
_NULLABLE_TEXT = {"type": ["string", "null"]}
_OPERATION = {
    "type": "object",
    "properties": {
        "kind": {"enum": ["create", "update", "prerequisites"]},
        "key": _TEXT,
        "taskId": _TEXT,
        "fields": {
            "type": "object",
            "properties": {
                "title": _TEXT,
                "description": _TEXT,
                "priority": {"enum": ["low", "normal", "high"]},
                "dueDate": _NULLABLE_TEXT,
                "tags": {"type": "array", "items": _TEXT},
                "assignedAgentId": _NULLABLE_TEXT,
                "assignedTeamId": _NULLABLE_TEXT,
            },
            "additionalProperties": False,
        },
        "after": {"type": "array", "items": _TEXT},
        "afterTaskIds": {"type": "array", "items": _TEXT},
    },
    "required": ["kind"],
    "additionalProperties": False,
}

_INPUTS = {
    "projects": (),
    "overview": ("projectId",),
    "tasks": ("projectId", "status", "query", "cursor", "limit"),
    "task": ("projectId", "taskId"),
    "review": ("projectId", "taskId"),
    "activity": ("projectId", "since", "cutoff", "cursor", "limit"),
    "threads": ("projectId",),
    "thread": ("projectId", "threadId"),
    "propose": ("projectId", "operations"),
}


def tool_definitions() -> list[Tool]:
    tools = []
    for name, operation in TOOL_OPERATIONS.items():
        properties: dict[str, Any] = (
            {}
            if operation == "projects"
            else {
                "projectId": {"type": "string", "minLength": 1, "maxLength": 128},
                "taskId": _TEXT,
                "threadId": _TEXT,
                "query": _TEXT,
                "status": _TEXT,
                "since": _TEXT,
                "cutoff": _TEXT,
                "cursor": {"anyOf": [{"type": "string"}, {"type": "number"}]},
                "limit": {"type": "integer", "minimum": 1, "maximum": 100},
                "operations": {"type": "array", "maxItems": 20, "items": _OPERATION},
            }
        )
        properties = {key: properties[key] for key in _INPUTS[operation]}
        if operation == "activity":
            properties["limit"] = {"type": "integer", "minimum": 1, "maximum": 50}
            properties["cursor"] = {"type": "integer", "minimum": 0}
        required = [] if operation == "projects" else ["projectId"]
        if operation in ("task", "review"):
            required.append("taskId")
        elif operation == "thread":
            required.append("threadId")
        elif operation == "propose":
            required.append("operations")
        tools.append(
            Tool(
                name=name,
                description=_DESCRIPTIONS[operation],
                inputSchema={
                    "type": "object",
                    "properties": properties,
                    "required": required,
                    "additionalProperties": False,
                },
                annotations=ToolAnnotations(readOnlyHint=operation != "propose", destructiveHint=False),
            )
        )
    return tools
