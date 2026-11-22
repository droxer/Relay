"""Resource-scoped Task and Automation tools using the ordinary domain services."""

from collections.abc import Iterator
from contextlib import contextmanager, nullcontext
from datetime import date
from typing import Any
from urllib.parse import quote, urlencode

from jsonschema import ValidationError, validate
from starlette.concurrency import run_in_threadpool

from ..automations.model import without_legacy_fields
from ..collaboration.queue import change_queue
from ..core.connections import ConnectionError
from ..persistence.engine import store_transaction
from ..projects.runtime import project_work_error
from ..projects.manager_reads import task_revision
from ..security.actor import Actor
from ..tasks.creation import TaskCreateRequest, create_task
from ..tasks.claims import dispatch_claim_active
from ..tasks.deletion import TaskDeletionError, delete_task
from ..tasks.dispatch import TaskDispatcher
from ..tasks.dispatch_outcome import DispatchResult
from ..tasks.requests import TaskRequestError, TaskRequestReader, parse_routine_fields
from ..tasks.review import task_review
from ..tasks.start import INVALID_STATE_DISPATCH, prepare_task_start
from ..tasks.update import TaskPatchRequest, update_task
from .access import active_command, assert_project_manage, assert_standalone, may_manage, scoped_project
from .catalog import START_TASK_INPUT, STOP_TASK_INPUT, TOOL_OPERATIONS, tool_definitions
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
    if actual_project_id is None and grant.get("computerId"):
        identity = task.get("computerId") or (task.get("workspaceBinding") or {}).get("computerId")
        if identity != grant["computerId"]:
            raise McpError(404, "work_not_found")
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
    automation_id = task.get("sourceRoutineId") or (task["id"] if task.get("isRoutine") else None)
    if task.get("projectId"):
        params = {"tab": "automations", "automation": automation_id} if automation_id else {"task": task["id"]}
        if task.get("sourceRoutineId"):
            params["run"] = task["id"]
        url = f"/projects/{quote(task['projectId'], safe='')}?{urlencode(params)}"
    else:
        identity = task.get("computerId") or (task.get("workspaceBinding") or {}).get("computerId")
        base = f"/computers/{quote(identity, safe='')}" if identity else ""
        url = f"{base}/automations/{automation_id}" if automation_id else f"{base}/tasks/{task['id']}"
        if task.get("sourceRoutineId"):
            url += f"/runs/{task['id']}"
    return {**public, "events": events[-50:],
            "revision": task_revision(task), "url": url,
            "coverage": {"totalEvents": len(events), "shownEvents": min(len(events), 50)}}


async def start_project_task(ctx: Any, grant: dict[str, Any], arguments: dict[str, Any]) -> dict[str, Any]:
    try:
        validate(arguments, START_TASK_INPUT)
    except ValidationError as error:
        raise McpError(400, "Invalid Task start arguments.") from error
    prepared = await run_in_threadpool(_prepare_project_task_start, ctx, grant, arguments)
    result = prepared if isinstance(prepared, dict) else await prepared[0].dispatch_prepared(prepared[1])
    session = result["session"]
    return {"task": _public(result["task"]), "threadId": session["id"] if session else None, "dispatch": result["dispatch"]}


@contextmanager
def _project_task_control(ctx: Any, grant: dict[str, Any], arguments: dict[str, Any]) -> Iterator[dict[str, Any]]:
    project_id = grant.get("workspaceProjectId")
    if not project_id or not grant.get("commandId") or not may_manage(grant):
        raise McpError(403, "project_manager_required")
    if arguments.get("projectId", project_id) != project_id:
        raise McpError(403, "Project scope mismatch.")
    task_id = arguments["taskId"]
    _record(ctx, grant, task_id, project_id, automation=False, write=True)
    try:
        # Serialize the decision with Lead reassignment and Task changes.
        with ctx.registry.dispatch_lock, ctx.project_store.manager_transaction(project_id, [task_id]):
            active_command(ctx, grant["commandId"])
            yield _record(ctx, grant, task_id, project_id, automation=False, write=True)
    except KeyError as error:
        if error.args != (project_id,):
            raise
        raise McpError(404, "project_not_found") from error


def _prepare_project_task_start(
    ctx: Any, grant: dict[str, Any], arguments: dict[str, Any],
) -> dict[str, Any] | DispatchResult | tuple[TaskDispatcher, dict[str, Any]]:
    actor: Actor = {"userId": grant["ownerUserId"], "isAdmin": False}
    try:
        with _project_task_control(ctx, grant, arguments) as task:
            prepared = prepare_task_start(ctx, task, raw_assignments=None, assignments=[], agent_requested=False)
            if isinstance(prepared, dict):
                return prepared
            task, _, assignments = prepared
            dispatcher = TaskDispatcher(ctx, task, actor, assignments=assignments, record_pending=True, retry_blocked=True)
            node, result = dispatcher.prepare()
            if node is not None:
                return dispatcher, node
            return result or {"task": task, "session": None, "dispatch": dict(INVALID_STATE_DISPATCH)}
    except TaskRequestError as error:
        raise McpError(error.status, str(error.detail)) from error


def stop_project_task(ctx: Any, grant: dict[str, Any], arguments: dict[str, Any]) -> dict[str, Any]:
    try:
        validate(arguments, STOP_TASK_INPUT)
    except ValidationError as error:
        raise McpError(400, "Invalid Task stop arguments.") from error
    with _project_task_control(ctx, grant, arguments) as task:
        request = ctx.daemon_store.active_run_request_for_task(task["id"])
        if request is None:
            if dispatch_claim_active(task):
                raise McpError(409, "task_dispatch_in_progress")
            return {"task": _public(task), "threadId": None, "outcome": "idle"}
        thread_id = request["sessionId"]
        session = ctx.session_store.get_session_header(thread_id)
        if session.get("projectId") != task["projectId"] or session.get("ownerUserId") != task["ownerUserId"]:
            raise McpError(403, "Task execution scope mismatch.")
        if not ctx.registry.get(request["nodeId"]):
            raise McpError(409, "task_run_not_stoppable")
        reason = arguments.get("reason", "").strip() or "Stopped by the Project Lead."
        stopped = ctx.backend.cancel_run(request["nodeId"], thread_id, reason, actor_user_id=grant["ownerUserId"])
        if stopped is None:
            raise McpError(409, "task_run_not_stoppable")
        change_queue(ctx.session_store, thread_id, "pause")
        return {
            "task": _public(ctx.task_store.get_task(task["id"])), "threadId": thread_id,
            "outcome": "settled" if stopped.get("status") in ("cancelled", "completed", "failed") else "stop_requested",
        }


def invoke_work(ctx: Any, grant: dict[str, Any], operation: str, arguments: dict[str, Any]) -> dict[str, Any]:
    """Never trust a supplied projectId over the stored record's Project."""
    definition = next(tool for tool in tool_definitions() if TOOL_OPERATIONS[tool.name] == operation)
    try:
        validate(arguments, definition.inputSchema)
    except ValidationError as error:
        raise McpError(400, "Invalid work tool arguments.") from error
    automation = "automation" in operation
    kind = "automation" if automation else "task"
    project_id = arguments.get("projectId", grant.get("workspaceProjectId"))
    if operation in ("tasks", "automations"):
        if not isinstance(arguments.get("cursor", ""), str):
            raise McpError(400, "Invalid work cursor.")
        _scope(ctx, grant, project_id, write=False)
        page = ctx.task_store.work_page(
            grant["ownerUserId"], project_id=project_id, automation=automation,
            computer_id=grant.get("computerId") if project_id is None else None,
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
                if project is not None:
                    body["projectId"] = project["id"]
                elif grant.get("computerId"):
                    body["computerId"] = grant["computerId"]
                if automation:
                    body["isRoutine"] = True
                task = create_task(ctx, actor, TaskCreateRequest(
                    body=body, reader=READER, title=body["title"].strip(),
                    owner=actor["userId"], assignee=actor["userId"], project=project,
                    project_session_fields=lambda selected: {},
                ))
            else:
                assert task is not None
                # MCP speaks for an Agent, even when its token carries the
                # owner's authority. That authority is not consent to replace
                # an already selected Agent. Check the locked, current record
                # before applying any part of the patch (including a clear or
                # a Team assignment, which would implicitly clear the Agent).
                if task.get("assignedAgentId") and (
                    ("assignedAgentId" in body and body["assignedAgentId"] != task["assignedAgentId"])
                    or body.get("assignedTeamId") or body.get("assignedWorkflowId")
                ):
                    raise McpError(
                        409,
                        "task_assignment_approval_required: Keep the assigned Agent. "
                        "Ask the owner to change the assignment in Relay; for Project Tasks, "
                        "you may stage a proposal for owner approval. No changes were applied.",
                    )
                if task.get("assignedWorkflowId") and (
                    ("assignedWorkflowId" in body and body["assignedWorkflowId"] != task["assignedWorkflowId"])
                    or body.get("assignedAgentId") or body.get("assignedTeamId")
                ):
                    raise McpError(409, "task_assignment_approval_required: Ask the owner to change the assigned Workflow in Relay.")
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
