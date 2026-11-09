"""Resource-scoped Task and Automation tools using the ordinary domain services."""

from contextlib import nullcontext
from datetime import date
from typing import Any

from jsonschema import ValidationError, validate

from ..automations.model import without_legacy_fields
from ..core.connections import ConnectionError
from ..persistence.engine import store_transaction
from ..projects.runtime import project_work_error
from ..projects.manager_reads import task_revision
from ..security.actor import Actor
from ..tasks.creation import TaskCreateRequest, create_task
from ..tasks.deletion import TaskDeletionError, delete_task
from ..tasks.requests import TaskRequestError, TaskRequestReader, parse_routine_fields
from ..tasks.review import task_review
from ..tasks.update import TaskPatchRequest, update_task
from .access import assert_project_manage, assert_standalone, scoped_project
from .catalog import TOOL_OPERATIONS, tool_definitions
from .errors import McpError


def _date(body: dict[str, Any], key: str) -> str | None:
    if key not in body:
        return None
    raw = body[key]
    if raw in (None, ""):
        return ""
    try:
        date.fromisoformat(raw)
    except (ValueError, TypeError) as error:
        raise McpError(400, "Dates must use YYYY-MM-DD.") from error
    return str(raw)


READER = TaskRequestReader(
    string=lambda body, key: body.get(key) or "", date=_date, routine=parse_routine_fields,
    assignments=lambda raw: [], participants=lambda assignments, agent: [],
)


def _record(ctx: Any, grant: dict[str, Any], record_id: str, project_id: str | None,
            *, automation: bool, write: bool = False) -> dict[str, Any]:
    try:
        task = ctx.task_store.get_task(record_id)
    except KeyError as error:
        raise McpError(404, "work_not_found") from error
    if task.get("deletedAt") or task.get("ownerUserId") != grant["ownerUserId"] or bool(task.get("isRoutine")) != automation:
        raise McpError(404, "work_not_found")
    actual_project_id = task.get("projectId")
    if project_id is not None and project_id != actual_project_id:
        raise McpError(403, "Project scope mismatch.")
    _scope(ctx, grant, actual_project_id, write=write)
    return task


def _scope(ctx: Any, grant: dict[str, Any], project_id: str | None,
           *, write: bool) -> dict[str, Any] | None:
    if project_id is None:
        assert_standalone(grant)
        return None
    project = scoped_project(ctx, grant, project_id)
    if write:
        assert_project_manage(grant, project)
        if code := project_work_error(project):
            raise McpError(409, code)
    return project


def _public(task: dict[str, Any]) -> dict[str, Any]:
    public = without_legacy_fields(task)
    events = public.get("events", [])
    return {**public, "events": events[-50:],
            "revision": task_revision(task),
            "url": (f"/projects/{task['projectId']}?{'automation' if task.get('isRoutine') else 'task'}={task['id']}"
                    if task.get("projectId") else f"/{'automations' if task.get('isRoutine') else 'tasks'}/{task['id']}"),
            "coverage": {"totalEvents": len(events), "shownEvents": min(len(events), 50)}}


def invoke_work(ctx: Any, grant: dict[str, Any], operation: str, arguments: dict[str, Any]) -> dict[str, Any]:
    """Never trust a supplied projectId over the stored record's Project."""
    definition = next(tool for tool in tool_definitions() if TOOL_OPERATIONS[tool.name] == operation)
    try:
        validate(arguments, definition.inputSchema)
    except ValidationError as error:
        raise McpError(400, "Invalid work tool arguments.") from error
    automation = "automation" in operation
    kind = "automation" if automation else "task"
    project_id = arguments.get("projectId")
    if operation in ("tasks", "automations"):
        if not isinstance(arguments.get("cursor", ""), str):
            raise McpError(400, "Invalid work cursor.")
        _scope(ctx, grant, project_id, write=False)
        page = ctx.task_store.work_page(
            grant["ownerUserId"], project_id=project_id, automation=automation,
            **{key: arguments[key] for key in ("status", "query", "cursor", "limit") if key in arguments},
        )
        return {kind + "s": [without_legacy_fields(task) for task in page["tasks"]],
                "total": page["total"], "nextCursor": page["nextCursor"]}
    task = None
    if not operation.startswith("create_"):
        task = _record(ctx, grant, arguments[f"{kind}Id"], project_id, automation=automation)
        project_id = task.get("projectId")
    if operation in ("task", "automation", "review"):
        assert task is not None
        if operation == "review" and task.get("linkedSessionIds"):
            try:
                source = ctx.session_store.get_session_header(task["linkedSessionIds"][-1])
            except KeyError:
                source = None
            if source and (source.get("ownerUserId") != grant["ownerUserId"]
                           or source.get("projectId") != task.get("projectId")):
                raise McpError(404, "thread_not_found")
        return task_review(ctx, task) if operation == "review" else {kind: _public(task)}
    # Serialize with dispatch and Project changes, and re-read the record and
    # lead inside the transaction before any domain mutation is made.
    actor: Actor = {"userId": grant["ownerUserId"], "isAdmin": False}
    project_lock = ctx.project_store.manager_transaction(project_id) if project_id else nullcontext()
    try:
        with ctx.registry.dispatch_lock, project_lock, store_transaction(ctx.task_store.engine):
            project = _scope(ctx, grant, project_id, write=True)
            if task:
                task = _record(ctx, grant, task["id"], project_id, automation=automation, write=True)
            if operation.startswith("delete_"):
                assert task is not None
                lifecycle = ctx.execution_lifecycle
                with lifecycle.admission_scope():
                    deleted = delete_task(ctx, task["id"], actor, execution_lifecycle=lifecycle)
                return {kind: _public(deleted["task"]), "outcome": deleted["outcome"]}
            body = dict(arguments["fields"])
            if "title" in body and not body["title"].strip():
                raise McpError(400, "title is required.")
            if operation.startswith("create_"):
                if automation:
                    body["isRoutine"] = True
                task = create_task(ctx, actor, TaskCreateRequest(
                    body=body, reader=READER, title=body["title"].strip(),
                    owner=actor["userId"], assignee=actor["userId"], project=project,
                    project_session_fields=lambda selected: {},
                ))
            else:
                assert task is not None
                task = update_task(ctx, actor, task, TaskPatchRequest(
                    body=body, reader=READER, requested_assignee=None, move_project=None,
                    reload=lambda: _record(ctx, grant, arguments[f"{kind}Id"], project_id, automation=automation, write=True),
                    automation_store=ctx.automation_store,
                ))
            if task.get("isRoutine") and task.get("routineState") == "active":
                if ctx.connections is None:
                    raise McpError(503, "connections_not_configured")
                ctx.connections.check_target(actor["userId"], "automation", task["id"])
            return {kind: _public(task)}
    except TaskRequestError as error:
        raise McpError(error.status, str(error.detail)) from error
    except TaskDeletionError as error:
        raise McpError(409, error.code) from error
    except ConnectionError as error:
        raise McpError(error.status, error.code) from error
