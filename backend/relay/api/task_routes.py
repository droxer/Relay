from __future__ import annotations

import asyncio
from collections.abc import Iterator
from contextlib import contextmanager
from datetime import date
from typing import Any

from fastapi import APIRouter, HTTPException, Request
from loguru import logger
from starlette.concurrency import run_in_threadpool

from ..automations.model import public_task_result, without_legacy_fields
from ..collaboration.awaiting import with_awaiting
from ..core.ids import new_database_id
from ..persistence.task_lifecycle import wip_limit
from ..persistence.workspace_artifacts import artifact_index_item, workspace_artifact_key, workspace_artifacts
from ..services.issue_triage import project_move_error
from ..services.produced_files import file_currency, listing_directories, live_status
from ..services.task_assignment import (
    logical_agent_for_assignment,
    team_for_assignment,
    validate_project_task_assignment,
)
from ..services.task_creation import TaskCreateRequest
from ..services.task_creation import create_task as create_task_record
from ..services.task_deletion import (
    TaskDeletionError,
    task_has_active_linked_session,
)
from ..services.task_deletion import (
    delete_task as delete_task_record,
)
from ..services.task_dispatch import DispatchResult, start_task_on_ready_node
from ..services.task_requests import (
    TaskRequestError,
    TaskRequestReader,
    ensure_issue_in_project,
    parse_routine_fields,
    update_task_unless_dispatching,
)
from ..services.task_start import PreparedStart, prepare_task_start, start_prepared_task
from ..services.task_update import TaskPatchRequest
from ..services.task_update import update_task as update_task_record
from ..services.task_workspace import (
    recorded_task_workspace,
    task_workspace_subpath,
)
from ..services.team_dispatch import TeamDispatchError, task_thread_ownership
from .actors import (
    actor_can_access_record,
    assignee_user_id_for_task,
    get_task_for_actor,
    get_task_or_404,
    owner_user_id_for_create,
    request_actor,
)
from .bodies import JsonBodyDep, assignment_list, json_body, participants_for_assignments, string_field
from .deps import AppContext, AppContextDep
from .project_helpers import ensure_task_project_writable, project_for_owner, project_session_fields
from .schemas import (
    TaskCreateBody,
    TaskCreateBodyDep,
    TaskPatchBody,
    TaskPatchBodyDep,
    TaskStartBody,
    openapi_body,
    parse_request_body,
)
from .workspace_transport import (
    dispatch_workspace_command,
    live_workspace_file,
    live_workspace_listing,
    raise_workspace_error,
    workspace_binding_command,
    workspace_binding_target,
    workspace_path,
)
from ..security.actor import Actor

router = APIRouter()


def public_task(task: dict[str, Any]) -> dict[str, Any]:
    """A task as the API answers it: legacy routine keys removed, and the wait
    it is parked on projected once (`awaiting`) so no client re-derives it."""
    return with_awaiting(without_legacy_fields(task))


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


@router.get("/tasks")
def list_tasks(request: Request, ctx: AppContextDep) -> dict[str, Any]:
    actor = request_actor(request, ctx.auth_store)
    summary_view = request.query_params.get("view") == "summary"
    raw_limit = request.query_params.get("limit")
    limit: int | None = None
    if raw_limit is not None:
        try:
            requested_limit = int(raw_limit)
        except ValueError as error:
            raise HTTPException(400, "limit must be an integer.") from error
        limit = min(max(1, requested_limit), 500)
    if summary_view and hasattr(ctx.task_store, "list_task_summaries"):
        tasks = ctx.task_store.list_task_summaries(
            user_id=None if actor["isAdmin"] else actor["userId"],
            limit=limit,
        )
    else:
        tasks = ctx.task_store.list_tasks(
            user_id=None if actor["isAdmin"] else actor["userId"],
            limit=limit,
        )
    return {
        "tasks": [public_task(task) for task in tasks],
        "flowPolicy": {"wipLimit": wip_limit(), "scope": "user"},
    }


@router.post("/tasks", status_code=201, openapi_extra=openapi_body(TaskCreateBody))
def create_task(
    request: Request, ctx: AppContextDep, *, _request_body: TaskCreateBodyDep
) -> dict[str, Any]:
    actor = request_actor(request, ctx.auth_store)
    title = _request_body.task_title()
    if not title:
        raise HTTPException(400, "title is required.")
    body = _request_body.as_dict()
    owner = owner_user_id_for_create(actor, body)
    assignee = assignee_user_id_for_task(actor, body, owner)
    project_id = _request_body.project_id or None
    project = project_for_owner(ctx, project_id, owner, require_enabled=True)
    with task_request_errors():
        task = create_task_record(
            ctx,
            actor,
            TaskCreateRequest(
                body=body,
                reader=request_reader(),
                title=title,
                owner=owner,
                assignee=assignee,
                project=project,
                project_session_fields=lambda selected: project_session_fields(ctx, selected),
            ),
        )
    return public_task(task)


@router.get("/tasks/{task_id}")
def get_task(task_id: str, request: Request, ctx: AppContextDep) -> dict[str, Any]:
    actor = request_actor(request, ctx.auth_store)
    return public_task(get_task_for_actor(ctx.task_store, task_id, actor))


@router.patch("/tasks/{task_id}", openapi_extra=openapi_body(TaskPatchBody))
def update_task(
    task_id: str, request: Request, ctx: AppContextDep, *, _request_body: TaskPatchBodyDep
) -> dict[str, Any]:
    actor = request_actor(request, ctx.auth_store)
    current = get_task_for_actor(ctx.task_store, task_id, actor)
    ensure_task_project_writable(ctx, current)
    # The services judge the PATCH by which fields it names, so they read the
    # body as sent; absent and null stay distinct.
    body = _request_body.as_dict()
    move_project = project_move_target(ctx, current, _request_body)
    requested_assignee = (
        assignee_user_id_for_task(actor, body, current.get("assigneeUserId"))
        if _request_body.names_assignee()
        else None
    )
    with task_request_errors():
        task = update_task_record(
            ctx,
            actor,
            current,
            TaskPatchRequest(
                body=body,
                reader=request_reader(),
                requested_assignee=requested_assignee,
                move_project=move_project,
                reload=lambda: get_task_for_actor(ctx.task_store, task_id, actor),
                automation_store=ctx.automation_store,
            ),
        )
    return public_task(task)


@router.delete("/tasks/{task_id}")
def delete_task(task_id: str, request: Request, ctx: AppContextDep) -> dict[str, Any]:
    actor = request_actor(request, ctx.auth_store)
    current = get_task_or_404(ctx.task_store, task_id)
    if not actor.get("isAdmin") and current.get("ownerUserId") != actor.get("userId"):
        raise HTTPException(403, "task_delete_forbidden")
    if not current.get("deletedAt"):
        ensure_task_project_writable(ctx, current)
    try:
        lifecycle = ctx.execution_lifecycle
        with ctx.registry.dispatch_lock, lifecycle.admission_scope():
            result = delete_task_record(ctx, task_id, actor, execution_lifecycle=lifecycle)
    except TaskDeletionError as error:
        status_code = {
            "task_not_found": 404,
            "task_delete_forbidden": 403,
            "task_execution_active": 409,
        }.get(error.code, 409)
        raise HTTPException(status_code, error.code) from error
    logger.info(
        "Task deleted",
        task_id=task_id,
        actor=actor.get("userId") or actor.get("username"),
        outcome=result["outcome"],
    )
    return public_task_envelope(result)


@router.put("/tasks/{task_id}/assignment")
def assign_task(
    task_id: str, request: Request, ctx: AppContextDep, *, _request_body: JsonBodyDep
) -> dict[str, Any]:
    actor = request_actor(request, ctx.auth_store)
    current = get_task_for_actor(ctx.task_store, task_id, actor)
    ensure_task_project_writable(ctx, current)
    with task_request_errors():
        return _assign_task(ctx, actor, current, _request_body)


def _assign_task(
    ctx: AppContext, actor: Actor, current: dict[str, Any], body: dict[str, Any]
) -> dict[str, Any]:
    task_id = current["id"]
    ensure_issue_in_project(current)
    if task_has_active_linked_session(ctx.session_store, current):
        raise HTTPException(409, "task_execution_active")
    assigned_agent_id = (
        string_field(body, "agentId") or string_field(body, "assignedAgentId") or None
    )
    assigned_team_id = (
        string_field(body, "teamId") or string_field(body, "assignedTeamId") or None
    )
    if assigned_agent_id and assigned_team_id:
        raise HTTPException(400, "task_agent_and_team_conflict")
    validate_project_task_assignment(
        ctx,
        current,
        assigned_agent_id=assigned_agent_id,
        assigned_team_id=assigned_team_id,
    )
    if assigned_team_id:
        team_for_assignment(
            ctx,
            actor,
            assigned_team_id,
            expected_user_id=current.get("assigneeUserId")
            or current.get("ownerUserId")
            or actor["userId"],
        )
        try:
            task_thread_ownership(
                {**current, "assignedTeamId": assigned_team_id},
                team_store=ctx.team_store,
                agent_store=ctx.agent_store,
            )
        except TeamDispatchError as error:
            raise HTTPException(409, error.code) from error
        return public_task_envelope(update_task_unless_dispatching(
            ctx,
            task_id,
            {
                "status": "assigned",
                "assignedAgentId": None,
                "assignedTeamId": assigned_team_id,
            },
        ))
    logical_agent = logical_agent_for_assignment(
        ctx,
        actor,
        assigned_agent_id,
        expected_user_id=current.get("assigneeUserId")
        or current.get("ownerUserId")
        or actor["userId"],
    )
    if not logical_agent or not assigned_agent_id:
        raise HTTPException(400, "agentId is required for task assignment.")
    return public_task_envelope(update_task_unless_dispatching(
        ctx,
        task_id,
        {
            "status": "assigned",
            "assignedAgent": logical_agent["executorKind"],
            "assignedAgentId": assigned_agent_id,
            "assignedTeamId": None,
        },
    ))


def _prepare_task_start(task_id: str, ctx: AppContext, actor: Actor, body: TaskStartBody) -> PreparedStart:
    task = get_task_for_actor(ctx.task_store, task_id, actor)
    if task.get("isRoutine") and not actor["isAdmin"] and task.get("ownerUserId") != actor.get("userId"):
        raise HTTPException(403, "Only the automation's owner or an admin can run it.")
    ensure_task_project_writable(ctx, task)
    raw_assignments = body.assignments
    with task_request_errors():
        return prepare_task_start(
            ctx,
            task,
            raw_assignments=raw_assignments,
            assignments=assignment_list(raw_assignments),
            agent_requested=body.requests_agent(),
        )


@router.post("/tasks/{task_id}/runs", status_code=202, openapi_extra=openapi_body(TaskStartBody))
async def start_task(
    task_id: str, request: Request, ctx: AppContextDep
) -> dict[str, Any]:
    # Every answer below carries a task (often the routine definition).
    return public_task_envelope(await _start_task(task_id, request, ctx))


async def _start_task(
    task_id: str, request: Request, ctx: AppContext
) -> dict[str, Any] | DispatchResult:
    actor = await run_in_threadpool(request_actor, request, ctx.auth_store)
    body = await parse_request_body(request, TaskStartBody)
    prepared = await run_in_threadpool(_prepare_task_start, task_id, ctx, actor, body)
    if isinstance(prepared, dict):
        return prepared
    task, _agent, assignments = prepared
    return await start_prepared_task(
        ctx, task, assignments, actor, automation_store=ctx.automation_store
    )


def _prepare_task_pickup(task_id: str, ctx: AppContext, actor: Actor, body: dict[str, Any]) -> Any:
    current = get_task_for_actor(ctx.task_store, task_id, actor)
    ensure_task_project_writable(ctx, current)
    with task_request_errors():
        return _pick_up(ctx, actor, current, body)


def _pick_up(
    ctx: AppContext, actor: Actor, current: dict[str, Any], body: dict[str, Any]
) -> tuple[dict[str, Any], str, str]:
    task_id = current["id"]
    ensure_issue_in_project(current)
    if current.get("status") not in ("backlog", "assigned"):
        raise HTTPException(409, "task_not_dispatchable")
    if task_has_active_linked_session(ctx.session_store, current):
        raise HTTPException(409, "task_execution_active")
    if current.get("assignedTeamId"):
        raise HTTPException(409, "team_task_requires_team_start")
    agent_id = string_field(body, "agentId") or string_field(body, "assignedAgentId")
    logical_agent = logical_agent_for_assignment(
        ctx,
        actor,
        agent_id,
        expected_user_id=current.get("assigneeUserId")
        or current.get("ownerUserId")
        or actor["userId"],
    )
    if not logical_agent or not agent_id:
        raise HTTPException(400, "agentId is required to pick up a task.")
    agent = logical_agent["executorKind"]
    task = update_task_unless_dispatching(
        ctx,
        task_id,
        {
            "assigneeUserId": logical_agent["supervisorUserId"],
            "status": "assigned",
            "assignedAgent": agent,
            "assignedAgentId": agent_id,
            "assignedTeamId": None,
        },
    )
    return task, agent_id, agent


@router.post("/tasks/{task_id}/pickups", status_code=202)
async def pickup_task(
    task_id: str, request: Request, ctx: AppContextDep
) -> dict[str, Any]:
    actor = await run_in_threadpool(request_actor, request, ctx.auth_store)
    body = await json_body(request)
    task, agent_id, agent = await run_in_threadpool(_prepare_task_pickup, task_id, ctx, actor, body)
    result = await start_task_on_ready_node(
        ctx,
        task,
        actor,
        assignments=[
            {
                "agentId": agent_id,
                "agent": agent,
            }
        ],
    )
    if not result:
        raise HTTPException(409, "task_not_dispatchable")
    logger.info(
        "Task picked up",
        task_id=task_id,
        session_id=(result.get("session") or {}).get("id"),
        agent=agent,
    )
    return public_task_envelope(result)


def occurrence_tasks(
    ctx: Any, task: dict[str, Any], actor: Actor
) -> list[dict[str, Any]]:
    """The routine's promoted occurrences the actor may read.

    A routine never runs itself — the scheduler promotes an occurrence task and
    that occurrence carries the run. Rolling its records up to the routine is
    what makes the routine's own surface show what its runs produced. An
    occurrence that was deleted, or that this actor cannot read, is skipped
    rather than failing the whole rollup.
    """
    if not task.get("isRoutine"):
        return []
    occurrences: list[dict[str, Any]] = []
    for occurrence_id in task.get("occurrenceIds") or []:
        try:
            occurrences.append(get_task_for_actor(ctx.task_store, occurrence_id, actor))
        except HTTPException:
            continue
        except Exception:  # noqa: BLE001 - one unreadable occurrence must not block the rest
            logger.warning(
                "Unexpected error reading routine occurrence",
                task_id=task.get("id"),
                occurrence_id=occurrence_id,
                exc_info=True,
            )
            continue
    return occurrences


@router.get("/tasks/{task_id}/events")
def task_events(
    task_id: str,
    request: Request,
    ctx: AppContextDep,
    include: str | None = None,
) -> dict[str, Any]:
    """The task's event log — the run history behind its current state.

    `include=occurrences` additionally folds in the event logs of a routine's
    promoted occurrences, merged by timestamp, so the routine shows the runs it
    caused. Each event keeps its own `taskId`, so the caller can still tell the
    routine's own entries from an occurrence's. The default answer stays the
    task's own log verbatim — an event-sourced replay must never silently
    receive another task's events.
    """
    actor = request_actor(request, ctx.auth_store)
    task = get_task_for_actor(ctx.task_store, task_id, actor)
    events = list(task["events"])
    if include == "occurrences":
        for occurrence in occurrence_tasks(ctx, task, actor):
            events.extend(occurrence["events"])
        events.sort(key=lambda event: event.get("timestamp") or "")
    return {"events": events}


def newest_artifacts_by_file(
    ctx: Any, sources: list[tuple[str, str]], *, all_versions: bool = False
) -> dict[str, dict[str, Any]]:
    """Workspace artifacts across `(taskId, sessionId)` pairs, newest per file.

    A file regenerated by a later run must surface once, at its latest state,
    attributed to the run that produced that state. Every surface that counts
    or lists a task's generated files goes through here so the ledger's counts
    and the artifact list can never disagree.
    """
    newest: dict[str, dict[str, Any]] = {}
    for origin_task_id, session_id in sources:
        try:
            session = ctx.session_store.get_session(session_id)
        except (KeyError, FileNotFoundError):
            continue  # A linked session may have been deleted; skip it.
        except Exception:  # noqa: BLE001 - one unreadable linked session must not block the rest
            logger.warning(
                "Unexpected error reading linked session for artifact aggregation",
                session_id=session_id,
                exc_info=True,
            )
            continue
        for artifact in workspace_artifacts(session):
            key = (
                f"{session_id}:{artifact['id']}"
                if all_versions
                else workspace_artifact_key(session, artifact)
            )
            current = newest.get(key)
            if current is None or (artifact.get("createdAt") or "") >= (
                current.get("createdAt") or ""
            ):
                newest[key] = {
                    **artifact_index_item(session, artifact),
                    "taskId": origin_task_id,
                }
    return newest


@router.get("/tasks/{task_id}/artifacts")
def task_artifacts(
    task_id: str, request: Request, ctx: AppContextDep
) -> dict[str, Any]:
    """Generated files (documents, decks, spreadsheets, …) produced while working the task.

    Aggregates workspace artifacts across the task's linked sessions and dedupes
    to the newest record per workspace file, so a file regenerated in a later
    session surfaces once at its latest state. For a routine the rollup also
    covers its promoted occurrences — the routine itself never runs, so its
    files are always produced by an occurrence's sessions.
    """
    actor = request_actor(request, ctx.auth_store)
    task = get_task_for_actor(ctx.task_store, task_id, actor)
    sources: list[tuple[str, str]] = [
        (task_id, session_id) for session_id in task.get("linkedSessionIds", [])
    ]
    for occurrence in occurrence_tasks(ctx, task, actor):
        sources.extend(
            (occurrence["id"], session_id)
            for session_id in occurrence.get("linkedSessionIds", [])
        )
    ordered = sorted(
        newest_artifacts_by_file(
            ctx, sources, all_versions=request.query_params.get("versions") == "all"
        ).values(),
        key=lambda item: item.get("createdAt") or "",
        reverse=True,
    )
    return {"taskId": task_id, "artifacts": ordered}


async def _task_directory_listings(
    ctx: AppContext,
    task: dict[str, Any],
    actor: Actor,
    directories: list[str],
) -> tuple[dict[str, dict[str, dict[str, Any]]], dict[str, Any]]:
    """Read live directories without letting an unavailable computer hide the index."""
    try:
        node, layout, subpath = await run_in_threadpool(_task_workspace_target, ctx, task, actor)
    except HTTPException as error:
        return {}, {
            "status": live_status(error),
            "entries": [],
            "path": directories[0],
        }

    async def _one(
        path: str,
    ) -> tuple[str, list[dict[str, Any]] | None, str | None]:
        try:
            event = await dispatch_workspace_command(
                ctx,
                node,
                _task_workspace_command(
                    task,
                    command_id=new_database_id(),
                    command_type="workspace.list",
                    path=path,
                    workspace_layout=layout,
                    workspace_subpath=subpath,
                ),
            )
            raise_workspace_error(event)
        except HTTPException as error:
            return path, None, live_status(error)
        if not event.get("exists"):
            return path, None, "not-created"
        return path, event.get("entries") or [], None

    results = await asyncio.gather(*(_one(path) for path in directories))
    listings: dict[str, dict[str, dict[str, Any]]] = {}
    root_entries: list[dict[str, Any]] = []
    root_failure: str | None = None
    for path, entries, failure in results:
        if path == directories[0]:
            root_failure = failure
        if entries is None:
            continue
        listings[path] = {entry["name"]: entry for entry in entries}
        if path == directories[0]:
            root_entries = entries
    if root_failure:
        return listings, {
            "status": root_failure,
            "entries": [],
            "path": directories[0],
        }
    return listings, {
        "status": "ok",
        "entries": root_entries,
        "path": directories[0],
    }


def _prepare_task_files(task_id: str, request: Request, ctx: AppContext) -> Any:
    actor = request_actor(request, ctx.auth_store)
    task = get_task_for_actor(ctx.task_store, task_id, actor)
    sources: list[tuple[str, str]] = [
        (task_id, session_id) for session_id in task.get("linkedSessionIds", [])
    ]
    for occurrence in occurrence_tasks(ctx, task, actor):
        sources.extend(
            (occurrence["id"], session_id)
            for session_id in occurrence.get("linkedSessionIds", [])
        )
    produced = sorted(
        newest_artifacts_by_file(
            ctx, sources, all_versions=request.query_params.get("versions") == "all"
        ).values(),
        key=lambda item: item.get("createdAt") or "",
        reverse=True,
    )
    root = workspace_path(request.query_params.get("path"))
    return actor, task, produced, root


@router.get("/tasks/{task_id}/files")
async def task_files(
    task_id: str, request: Request, ctx: AppContextDep
) -> dict[str, Any]:
    """Return what the task produced, enriched by live workspace state."""
    actor, task, produced, root = await run_in_threadpool(_prepare_task_files, task_id, request, ctx)
    listings, live = await _task_directory_listings(
        ctx, task, actor, listing_directories(produced, root=root)
    )
    claimed = {item.get("workspaceRelativePath") for item in produced}
    return {
        "taskId": task_id,
        "produced": [
            {**item, "currency": file_currency(item, listings)} for item in produced
        ],
        "live": {
            **live,
            "entries": [
                entry
                for entry in live["entries"]
                if entry.get("path") not in claimed
            ],
        },
    }


def _task_workspace_target(
    ctx: Any, task: dict[str, Any], actor: Actor
) -> tuple[dict[str, Any], str, str]:
    """Resolve live reads from the same recorded identity used for execution."""
    nodes = ctx.registry.monitor_nodes()
    binding = recorded_task_workspace(task, ctx.session_store, nodes)
    if task.get("isRoutine"):
        # A routine is a browse-only parent; each occurrence owns its binding.
        for occurrence in reversed(occurrence_tasks(ctx, task, actor)):
            binding = recorded_task_workspace(occurrence, ctx.session_store, nodes)
            if binding:
                if binding["layout"] == "task":
                    binding = {**binding, "subpath": task_workspace_subpath(task)}
                break
    if not binding:
        reason = (
            "workspace-not-created"
            if not task.get("linkedSessionIds")
            else "placement-unavailable"
        )
        raise HTTPException(
            409 if reason == "workspace-not-created" else 503,
            {"reason": reason, "code": reason},
        )
    return workspace_binding_target(nodes, binding)


def _task_workspace_command(
    task: dict[str, Any],
    *,
    command_id: str,
    command_type: str,
    path: str,
    workspace_layout: str,
    workspace_subpath: str,
) -> dict[str, Any]:
    # Task ids use the same validated database-id alphabet as sessions. The
    # daemon treats this only as a routing identifier; workspaceSubpath is
    # what selects the durable task root.
    return workspace_binding_command(
        routing_id=task["id"],
        command_id=command_id,
        command_type=command_type,
        path=path,
        workspace_layout=workspace_layout,
        workspace_subpath=workspace_subpath,
    )


@router.get("/tasks/{task_id}/workspace/status")
def task_workspace_status(
    task_id: str, request: Request, ctx: AppContextDep
) -> dict[str, Any]:
    """Small polling response; never dispatches a filesystem read just to show a wait."""
    actor = request_actor(request, ctx.auth_store)
    task = get_task_for_actor(ctx.task_store, task_id, actor)
    waiting = task.get("workspaceWaiting")
    active = ctx.daemon_store.list_active_runs() if waiting else []
    if not waiting or not any(run["runId"] == waiting["runId"] for run in active):
        return {"waiting": False}
    result: dict[str, Any] = {"waiting": True}
    blocker = waiting.get("blockingSessionId")
    if blocker and any(run["sessionId"] == blocker for run in active):
        try:
            session = ctx.session_store.get_session(blocker)
        except (KeyError, FileNotFoundError):
            session = None
        if session and actor_can_access_record(actor, session):
            result["blockingSessionId"] = blocker
            result["blockingTitle"] = session.get("taskGoal") or ""
    return result


@router.get("/tasks/{task_id}/workspace/files")
async def task_workspace_files(
    task_id: str, request: Request, ctx: AppContextDep
) -> dict[str, Any]:
    """Live listing of the directory this task's rounds share.

    Live reads need the computer to be up. The artifact index remains the
    durable record of what a task produced.
    """
    actor = await run_in_threadpool(request_actor, request, ctx.auth_store)
    task = await run_in_threadpool(get_task_for_actor, ctx.task_store, task_id, actor)
    path = workspace_path(request.query_params.get("path"))
    node, workspace_layout, workspace_subpath = await run_in_threadpool(_task_workspace_target, ctx, task, actor)
    event = await dispatch_workspace_command(
        ctx,
        node,
        _task_workspace_command(
            task,
            command_id=new_database_id(),
            command_type="workspace.list",
            path=path,
            workspace_layout=workspace_layout,
            workspace_subpath=workspace_subpath,
        ),
    )
    raise_workspace_error(event)
    return live_workspace_listing(
        event,
        path=path,
        metadata={
            "taskId": task["id"],
            "scope": "shared",
            "nodeId": node["id"],
            "workspaceLayout": workspace_layout,
            "sharedWithProject": workspace_layout == "project",
        },
    )


@router.get("/tasks/{task_id}/workspace/file")
async def task_workspace_file(
    task_id: str, request: Request, ctx: AppContextDep
) -> dict[str, Any]:
    actor = await run_in_threadpool(request_actor, request, ctx.auth_store)
    task = await run_in_threadpool(get_task_for_actor, ctx.task_store, task_id, actor)
    path = workspace_path(request.query_params.get("path"), required=True)
    node, workspace_layout, workspace_subpath = await run_in_threadpool(_task_workspace_target, ctx, task, actor)
    event = await dispatch_workspace_command(
        ctx,
        node,
        _task_workspace_command(
            task,
            command_id=new_database_id(),
            command_type="workspace.read",
            path=path,
            workspace_layout=workspace_layout,
            workspace_subpath=workspace_subpath,
        ),
    )
    raise_workspace_error(event)
    return live_workspace_file(
        event,
        path=path,
        metadata={
            "taskId": task["id"],
            "scope": "shared",
            "nodeId": node["id"],
            "workspaceLayout": workspace_layout,
            "sharedWithProject": workspace_layout == "project",
        },
    )


# A routine that has run nightly for a year has hundreds of occurrences; the
# ledger answers "is this healthy lately", so it reads recent runs by default.
RUN_LEDGER_LIMIT = 30
RUN_LEDGER_MAX_LIMIT = 200
# The task statuses that end a run. There is no "failed" task status — a run
# that went wrong lands in `blocked`, carrying the reason that put it there.
RUN_TERMINAL_STATUSES = ("done", "blocked")


def run_row(ctx: Any, task: dict[str, Any]) -> dict[str, Any]:
    """One run of `task`, summarized for the ledger.

    Timing comes from the status events rather than the snapshot: `updatedAt`
    moves for edits that have nothing to do with the run, and a run that is
    still going has no end at all.
    """
    started_at: str | None = None
    ended_at: str | None = None
    failure_message: str | None = None
    for event in task.get("events", []):
        if event.get("type") != "task.status":
            continue
        status = event.get("status")
        if status == "running" and started_at is None:
            started_at = event.get("timestamp")
        elif status in RUN_TERMINAL_STATUSES:
            ended_at = event.get("timestamp")
            failure_message = event.get("reason") if status == "blocked" else None
    if task.get("status") not in RUN_TERMINAL_STATUSES:
        ended_at = None
        failure_message = None
    session_ids = list(task.get("linkedSessionIds", []))
    artifacts = newest_artifacts_by_file(
        ctx, [(task["id"], session_id) for session_id in session_ids]
    )
    return {
        "taskId": task["id"],
        "scheduledFor": task.get("scheduledFor") or task.get("dueDate"),
        "status": task.get("status"),
        "createdAt": task.get("createdAt"),
        "startedAt": started_at,
        "endedAt": ended_at,
        "failureMessage": failure_message,
        "sessionIds": session_ids,
        "latestSessionId": session_ids[-1] if session_ids else None,
        "artifactCount": len(artifacts),
        "triggerKind": task.get("routineTriggerKind"),
        "triggerSummary": task.get("routineTriggerSummary"),
    }


@router.get("/tasks/{task_id}/runs")
def task_runs(
    task_id: str,
    request: Request,
    ctx: AppContextDep,
    limit: int = RUN_LEDGER_LIMIT,
) -> dict[str, Any]:
    """The task's run ledger — one row per run, newest first.

    A routine never runs itself: the scheduler promotes an occurrence and that
    occurrence carries the run, so a routine's rows are its occurrences. A
    plain task ran as itself and gets a single row, which keeps the ledger one
    component on the client instead of two shapes to switch between.

    Rows are dated by the day the run was scheduled for, so a routine reads as
    a calendar of its runs rather than as promotion bookkeeping.
    """
    if limit < 1:
        raise HTTPException(400, "limit must be at least 1.")
    actor = request_actor(request, ctx.auth_store)
    task = get_task_for_actor(ctx.task_store, task_id, actor)
    occurrences = occurrence_tasks(ctx, task, actor)
    runs = [run_row(ctx, occurrence) for occurrence in occurrences] if occurrences else (
        [] if task.get("isRoutine") else [run_row(ctx, task)]
    )
    runs.sort(
        key=lambda run: (run.get("scheduledFor") or "", run.get("createdAt") or ""),
        reverse=True,
    )
    return {"taskId": task_id, "runs": runs[: min(limit, RUN_LEDGER_MAX_LIMIT)]}
