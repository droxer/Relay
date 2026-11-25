"""The authoritative Relay MCP tool catalog and input schemas."""

from typing import Any
from mcp.types import Tool, ToolAnnotations
from ..automations.model import MAX_TRIGGERS

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
    "relay_create_task": "create_task",
    "relay_start_task": "start_task",
    "relay_stop_task": "stop_task",
    "relay_update_task": "update_task",
    "relay_delete_task": "delete_task",
    "relay_list_automations": "automations",
    "relay_get_automation": "automation",
    "relay_create_automation": "create_automation",
    "relay_update_automation": "update_automation",
    "relay_delete_automation": "delete_automation",
    "relay_create_workflow": "create_workflow",
}
_DESCRIPTIONS = {
    "projects": "List Projects this token can access.",
    "overview": "Read current Project goal, context, roster and Task counts.",
    "tasks": "List Tasks. Omit projectId for the current run scope; standalone work is limited to the current Computer.",
    "task": "Read a Task and its current revision before proposing edits.",
    "review": "Read Task review evidence.",
    "activity": "Read Project activity within an explicit time window.",
    "threads": "List Project Threads.",
    "thread": "Read a Project Thread.",
    "propose": "Stage up to 20 Task operations for owner review. Does not apply or start work.",
    "automations": "List Automations. Omit projectId for the current run scope.",
    "automation": "Read an Automation, its triggers and current state.",
}
_TEXT = {"type": "string"}
_NULLABLE_TEXT = {"type": ["string", "null"]}
_RESOURCE_ID = {"type": "string", "minLength": 1, "maxLength": 128}
_TASK_CONTROL_FIELDS = {"taskId": _RESOURCE_ID, "projectId": _RESOURCE_ID}
START_TASK_INPUT = {
    "type": "object",
    "properties": _TASK_CONTROL_FIELDS,
    "required": ["taskId"],
    "additionalProperties": False,
}
STOP_TASK_INPUT = {
    **START_TASK_INPUT,
    "properties": {**_TASK_CONTROL_FIELDS, "reason": {"type": "string", "maxLength": 2000}},
}
_WORKFLOW_REQUIREMENTS = {
    "type": "array", "minItems": 1, "maxItems": 32,
    "items": {"type": "string", "minLength": 1, "maxLength": 2000},
}
CREATE_WORKFLOW_INPUT = {
    "type": "object",
    "required": ["projectId", "name", "workflowSteps"],
    "additionalProperties": False,
    "properties": {
        "projectId": _RESOURCE_ID,
        "name": {"type": "string", "minLength": 1, "maxLength": 200},
        "enabled": {"type": "boolean", "default": True},
        "workflowSteps": {
            "type": "array", "minItems": 1, "maxItems": 64,
            "items": {
                "type": "object",
                "required": ["id", "name", "agentId", "instructions", "acceptanceCriteria"],
                "additionalProperties": False,
                "properties": {
                    "id": {"type": "string", "minLength": 1, "maxLength": 64, "pattern": "^[A-Za-z0-9_-]+$"},
                    "name": {"type": "string", "minLength": 1, "maxLength": 200},
                    "agentId": _RESOURCE_ID,
                    "instructions": {"type": "string", "minLength": 1, "maxLength": 8000},
                    "acceptanceCriteria": _WORKFLOW_REQUIREMENTS,
                    "requiresApproval": {"type": "boolean", "default": False},
                    "expectedOutputs": _WORKFLOW_REQUIREMENTS,
                    "kind": {"enum": ["work", "deployment"]},
                },
            },
        },
    },
}
WORK_FIELDS = {
    "title": {"type": "string", "minLength": 1, "maxLength": 200},
    "description": {"type": "string", "maxLength": 20000},
    "priority": {"enum": ["low", "normal", "high"]},
    "dueDate": _NULLABLE_TEXT,
    "tags": {"type": "array", "maxItems": 50, "items": {"type": "string", "maxLength": 100}},
    "assignedAgentId": _NULLABLE_TEXT,
    "assignedTeamId": _NULLABLE_TEXT,
    "assignedWorkflowId": {
        "type": ["string", "null"], "minLength": 1, "maxLength": 128,
        "description": "A Project Custom Workflow ID or preset:build_review, preset:pipeline, or preset:lead_led.",
    },
    "status": {"enum": ["backlog", "assigned", "blocked", "cancelled"]},
    "blockerReason": {"type": "string", "maxLength": 2000},
}
AUTOMATION_FIELDS = {
    **WORK_FIELDS,
    "routineState": {"enum": ["active", "paused"]},
    "routineTriggers": {
        "type": "array", "maxItems": MAX_TRIGGERS,
        "description": "Replace all triggers. [] means manual runs only. Schedule example: {kind:'schedule',schedule:{timezone:'UTC',repeat:{every:'day',at:'09:00'}}}. Event example: {kind:'task_event',on:'status_changed',filters:{toStatus:'blocked'}}.",
        "items": {
            "type": "object", "required": ["kind"], "additionalProperties": False,
            "properties": {
                "kind": {"enum": ["schedule", "task_event", "run_event", "webhook"]},
                "on": {"enum": ["created", "status_changed", "completed", "failed"]},
                "schedule": {
                    "type": "object", "required": ["repeat"], "additionalProperties": False,
                    "properties": {
                        "timezone": {**_NULLABLE_TEXT, "description": "IANA timezone; null uses the server timezone."},
                        "repeat": {
                            "type": "object", "additionalProperties": False,
                            "description": "Use {every:'hour',minute:0}, {every:'day'|'weekday',at:'HH:MM'}, {every:'week',at:'HH:MM',days:[1..7]}, {every:'month',at:'HH:MM',day:1..31}, {once:'YYYY-MM-DDTHH:MM'}, or {cron:'5-field expression'} (at least 15 minutes apart).",
                            "properties": {
                                "every": {"enum": ["hour", "day", "weekday", "week", "month"]},
                                "minute": {"type": "integer", "minimum": 0, "maximum": 59},
                                "at": _TEXT, "once": _TEXT, "cron": _TEXT,
                                "days": {"type": "array", "minItems": 1, "maxItems": 7,
                                         "items": {"type": "integer", "minimum": 1, "maximum": 7}},
                                "day": {"type": "integer", "minimum": 1, "maximum": 31},
                            },
                        },
                    },
                },
                "filters": {
                    "type": "object", "additionalProperties": False,
                    "properties": {key: _TEXT for key in (
                        "projectId", "assignedAgentId", "assignedTeamId", "fromStatus", "toStatus", "priority", "titleContains",
                    )},
                },
            },
        },
    },
}
WORK_OPERATIONS = {"tasks", "task", "review", "automations", "automation",
                   "create_task", "update_task", "delete_task",
                   "create_automation", "update_automation", "delete_automation"}
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
    "automations": ("projectId", "status", "query", "cursor", "limit"),
    "automation": ("projectId", "automationId"),
}


def tool_definitions(*, may_manage: bool = True) -> list[Tool]:
    """Hide Project Lead-only tools from grants without Project write access."""
    tools = []
    properties: dict[str, Any]
    for name, operation in TOOL_OPERATIONS.items():
        if operation in ("propose", "create_workflow", "start_task", "stop_task") and not may_manage:
            continue
        if operation == "start_task":
            tools.append(Tool(
                name=name,
                description=(
                    "Start an existing Task as the current Project Lead. Relay uses its saved assignment "
                    "and enforces prerequisites, capacity and Workflow approval gates. "
                    "Returns the dispatch outcome and the Thread ID when started."
                ),
                inputSchema=START_TASK_INPUT,
                annotations=ToolAnnotations(readOnlyHint=False, destructiveHint=False),
            ))
            continue
        if operation == "stop_task":
            tools.append(Tool(
                name=name,
                description=(
                    "Request that an active Project Task execution stop. Only the current Project Lead "
                    "can request a stop. The Task and its assignment are retained."
                ),
                inputSchema=STOP_TASK_INPUT,
                annotations=ToolAnnotations(readOnlyHint=False, destructiveHint=False),
            ))
            continue
        if operation == "create_workflow":
            tools.append(Tool(
                name=name,
                description=(
                    "Save a reusable Workflow with ordered steps in the current Project for later runs. "
                    "Only its Lead can create it. Each step needs an enabled Project Agent placed on the Project's Computer."
                ),
                inputSchema=CREATE_WORKFLOW_INPUT,
                annotations=ToolAnnotations(readOnlyHint=False, destructiveHint=False),
            ))
            continue
        if operation.startswith(("create_", "update_", "delete_")):
            kind = operation.split("_", 1)[1]
            verb = operation.split("_", 1)[0]
            id_key = f"{kind}Id"
            properties = {"projectId": _RESOURCE_ID}
            required = []
            if verb != "create":
                properties[id_key] = _TEXT
                required.append(id_key)
            if verb != "delete":
                properties["fields"] = {
                    "type": "object", "properties": AUTOMATION_FIELDS if kind == "automation" else WORK_FIELDS,
                    "additionalProperties": False, "minProperties": 1,
                    **({"required": ["title"]} if verb == "create" else {}),
                }
                required.append("fields")
            tools.append(Tool(
                name=name,
                description=f"{verb.title()} {'an Automation' if kind == 'automation' else 'a Task'}. Standalone runs manage work only on their Computer. The Project Lead manages work in its Project and can assign an Agent or Project Workflow. Changes to a saved Agent or Workflow assignment require owner approval. Acceptance and execution recovery remain owner-only.",
                inputSchema={"type": "object", "properties": properties, "required": required, "additionalProperties": False},
                annotations=ToolAnnotations(readOnlyHint=False, destructiveHint=verb == "delete"),
            ))
            continue
        properties = (
            {}
            if operation == "projects"
            else {
                "projectId": _RESOURCE_ID,
                "taskId": _TEXT,
                "automationId": _TEXT,
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
        elif operation in ("tasks", "automations"):
            properties["cursor"] = {"type": "string", "maxLength": 128}
            properties["query"] = {"type": "string", "maxLength": 500}
            properties["status"] = {"type": "string", "maxLength": 128}
        required = [] if operation in WORK_OPERATIONS or operation == "projects" else ["projectId"]
        if operation in ("task", "review"):
            required.append("taskId")
        elif operation == "automation":
            required.append("automationId")
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
