from __future__ import annotations

import asyncio
from typing import Any

from fastapi import APIRouter, HTTPException, Request
from starlette.concurrency import run_in_threadpool

from ...core.ids import new_database_id
from ...security.actor import Actor
from ...tasks.produced_files import file_currency, listing_directories, live_status
from ...tasks.workspace import (
    recorded_task_workspace,
    task_workspace_subpath,
)
from ..actors import (
    actor_can_access_record,
    get_task_for_actor,
    request_actor,
)
from ..computers.workspace_transport import (
    dispatch_workspace_command,
    live_workspace_file,
    live_workspace_listing,
    raise_workspace_error,
    workspace_binding_command,
    workspace_binding_target,
    workspace_path,
)
from ..deps import AppContext, AppContextDep
from .history import newest_artifacts_by_file, occurrence_tasks

router = APIRouter()


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
