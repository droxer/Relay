from __future__ import annotations

import base64
from typing import Any
from urllib.parse import quote

from fastapi import APIRouter, HTTPException, Request, Response
from fastapi.responses import PlainTextResponse
from starlette.concurrency import run_in_threadpool

from ...core.ids import new_database_id
from ...persistence.session.workspace_artifacts import is_workspace_artifact
from ...tasks.workspace import recorded_session_workspace
from ..actors import (
    get_session_for_actor,
    request_actor_or_sandbox,
)
from ..computers.workspace_transport import (
    dispatch_workspace_command,
    raise_workspace_error,
    workspace_binding_command,
    workspace_binding_target,
    workspace_path,
)
from ..deps import AppContext, AppContextDep
from .projections import session_artifact

router = APIRouter()


@router.get("/threads/{session_id}/artifacts/{artifact_id}")
async def read_artifact(
    session_id: str, artifact_id: str, request: Request, ctx: AppContextDep
) -> Any:
    actor = await run_in_threadpool(
        request_actor_or_sandbox, request, ctx.auth_store, ctx.registry
    )
    session = await run_in_threadpool(
        get_session_for_actor, ctx.session_store, session_id, actor
    )
    artifact = session_artifact(session, artifact_id)
    if artifact and is_workspace_artifact(artifact):
        # Workspace paths belong to the execution plane. A same-named host
        # file is never evidence that this backend shares the daemon's storage.
        read_content = getattr(ctx.session_store, "read_artifact_content", None)
        content = (
            await run_in_threadpool(read_content, session_id, artifact_id)
            if read_content
            else None
        )
        if content is None:
            # The daemon snapshots only small document types; every other file
            # it reports is read back from the computer that wrote it.
            content = await _live_artifact_content(ctx, session, artifact)
        return Response(
            content,
            media_type=artifact.get("contentType") or "application/octet-stream",
            headers={
                "Content-Disposition": (
                    "attachment; filename*=UTF-8''"
                    + quote(str(artifact.get("title") or artifact_id), safe="")
                ),
                "Content-Security-Policy": (
                    "sandbox; default-src 'none'; base-uri 'none'; "
                    "frame-ancestors 'none'"
                ),
            },
        )
    try:
        text = await run_in_threadpool(
            ctx.session_store.read_artifact, session_id, artifact_id
        )
    except (KeyError, FileNotFoundError, OSError):
        raise HTTPException(404, "Artifact not found.") from None
    return PlainTextResponse(text)


async def _live_artifact_content(
    ctx: AppContext, session: dict[str, Any], artifact: dict[str, Any]
) -> bytes:
    """A generated file's current bytes, read from its thread's workspace.

    Only the path the daemon itself reported is read, through the same
    `workspace.read` command the task and project browsers use. A file past
    the live read limit is refused rather than served cut short."""
    relative = artifact.get("workspaceRelativePath")
    if not isinstance(relative, str) or not relative:
        raise HTTPException(404, "Artifact not found.")
    path = workspace_path(relative, required=True)
    nodes = await run_in_threadpool(ctx.registry.monitor_nodes)
    binding = recorded_session_workspace(session, nodes)
    if not binding:
        raise HTTPException(404, "Artifact not found.")
    node, layout, subpath = workspace_binding_target(nodes, binding)
    event = await dispatch_workspace_command(
        ctx,
        node,
        workspace_binding_command(
            routing_id=session["id"],
            command_id=new_database_id(),
            command_type="workspace.read",
            path=path,
            workspace_layout=layout,
            workspace_subpath=subpath,
        ),
    )
    raise_workspace_error(event)
    if event.get("truncated"):
        raise HTTPException(
            413, {"reason": "artifact-too-large", "code": "artifact-too-large"}
        )
    raw = event.get("contentBase64")
    return base64.b64decode(raw) if isinstance(raw, str) else b""
