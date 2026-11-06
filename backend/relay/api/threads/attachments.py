"""Bounded private image uploads and command-scoped daemon downloads."""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, HTTPException, Request, Response
from starlette.concurrency import run_in_threadpool

from ...core.thread_attachments import MAX_IMAGE_BYTES
from ..actors import bearer_token, get_session_for_actor, request_actor
from ..deps import AppContextDep

router = APIRouter()
_HEADERS = {"Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff"}


@router.post("/thread-attachments", status_code=201)
async def upload_image(request: Request, ctx: AppContextDep) -> dict[str, Any]:
    actor = await run_in_threadpool(request_actor, request, ctx.auth_store)
    retry_after = ctx.auth_rate_limiter.consume(f"thread-image:{actor['userId']}")
    if retry_after is not None:
        raise HTTPException(
            429, "Too many image uploads. Try again shortly.", headers={"Retry-After": str(retry_after)}
        )
    media_type = request.headers.get("content-type", "").split(";", 1)[0].strip().lower()
    content = bytearray()
    async for chunk in request.stream():
        if len(content) + len(chunk) > MAX_IMAGE_BYTES:
            raise HTTPException(413, "Images must be at most 10 MB.")
        content.extend(chunk)
    try:
        return await run_in_threadpool(ctx.session_store.create_attachment, actor["userId"], bytes(content), media_type)
    except ValueError as error:
        raise HTTPException(400, str(error)) from error


@router.get("/thread-attachments/{attachment_id}")
def read_image(attachment_id: str, request: Request, ctx: AppContextDep) -> Response:
    actor = request_actor(request, ctx.auth_store)
    row = ctx.session_store.attachment(attachment_id)
    if not row:
        raise HTTPException(404, "Image unavailable.")
    if row["session_id"]:
        get_session_for_actor(ctx.session_store, row["session_id"], actor)
    elif row["owner_user_id"] != actor["userId"]:
        raise HTTPException(404, "Image unavailable.")
    return _image_response(attachment_id, ctx)


@router.get("/daemon-nodes/{sandbox_id}/attachments/{attachment_id}")
def daemon_image(sandbox_id: str, attachment_id: str, request: Request, ctx: AppContextDep) -> Response:
    try:
        ctx.registry.assert_node_event_authorized(sandbox_id, bearer_token(request))
    except (PermissionError, KeyError) as error:
        raise HTTPException(401, "Unauthorized daemon node.") from error
    command_id = request.query_params.get("commandId") or ""
    record = ctx.daemon_store.get_command(command_id) if command_id else None
    command = (record or {}).get("command") or {}
    if not (
        record
        and record.get("nodeId") == sandbox_id
        and record.get("status") == "dispatched"
        and command.get("type") == "run.start"
        and any(image.get("id") == attachment_id for image in command.get("attachments", []))
    ):
        raise HTTPException(404, "Image unavailable.")
    return _image_response(attachment_id, ctx)


def _image_response(attachment_id: str, ctx: AppContextDep) -> Response:
    stored = ctx.session_store.read_attachment(attachment_id)
    if stored is None:
        raise HTTPException(404, "Image unavailable.")
    metadata, content = stored
    return Response(content, media_type=metadata["mediaType"], headers=_HEADERS)
