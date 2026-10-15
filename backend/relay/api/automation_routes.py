"""Inbound webhooks for automations, and the secret that guards them.

The webhook only queues: it writes an outbox row and answers 202. The
scheduler's matcher turns the row into a run, the same as any other trigger.
"""

from __future__ import annotations

import json
from datetime import datetime, timezone
from typing import Any

from fastapi import APIRouter, HTTPException, Request
from fastapi.concurrency import run_in_threadpool

from ..automations.model import TriggerError, has_webhook, is_active, public_task_result
from ..automations.service import automation_service
from ..automations.schedule import ScheduleError, next_fires, normalize_schedule, summarize
from ..security.edge import client_ip
from .contract import API_PREFIX
from .deps import AppContextDep
from .helpers import get_task_for_actor, json_body, request_actor

router = APIRouter()

WEBHOOK_TOKEN_HEADER = "X-Relay-Automation-Token"
WEBHOOK_BODY_LIMIT = 64 * 1024
PREVIEW_FIRES = 3


def webhook_path(routine_id: str) -> str:
    return f"{API_PREFIX}/automations/{routine_id}/webhook"


async def _capped_body(request: Request) -> bytes:
    declared = request.headers.get("content-length")
    if declared and declared.isdigit() and int(declared) > WEBHOOK_BODY_LIMIT:
        raise HTTPException(413, "Webhook body exceeds 64 KB.")
    body = bytearray()
    async for chunk in request.stream():
        body.extend(chunk)
        if len(body) > WEBHOOK_BODY_LIMIT:
            raise HTTPException(413, "Webhook body exceeds 64 KB.")
    return bytes(body)


def _too_many(retry_after: int) -> HTTPException:
    return HTTPException(429, "Too many webhook calls.", headers={"Retry-After": str(retry_after)})


@router.post("/automations/{routine_id}/webhook", status_code=202)
async def receive_automation_webhook(routine_id: str, request: Request) -> dict[str, Any]:
    # Failed tokens are limited per caller and successful calls per automation,
    # so a stranger spamming bad tokens cannot lock out the real sender.
    failures = request.app.state.automation_webhook_failure_limiter
    caller = client_ip(request)
    retry_after = failures.retry_after(caller)
    if retry_after:
        raise _too_many(retry_after)
    store = request.app.state.automation_store
    token = request.headers.get(WEBHOOK_TOKEN_HEADER, "")
    if not token or not await run_in_threadpool(store.verify_webhook_secret, routine_id, token):
        retry_after = failures.consume(caller)
        if retry_after:
            raise _too_many(retry_after)
        raise HTTPException(401, "Invalid automation token.")
    retry_after = request.app.state.automation_webhook_limiter.consume(routine_id)
    if retry_after:
        raise _too_many(retry_after)
    if request.headers.get("content-type", "").split(";")[0].strip().lower() != "application/json":
        raise HTTPException(415, "Webhook body must be application/json.")
    body = await _capped_body(request)
    try:
        payload = json.loads(body)
    except ValueError as error:
        raise HTTPException(400, "Webhook body is not valid JSON.") from error
    try:
        routine = await run_in_threadpool(request.app.state.task_store.get_task, routine_id)
    except (KeyError, FileNotFoundError) as error:
        raise HTTPException(409, "automation_unavailable") from error
    if not (is_active(routine) and has_webhook(routine)):
        raise HTTPException(409, "automation_unavailable")
    await run_in_threadpool(store.enqueue_webhook, routine_id, payload)
    return {"accepted": True}


def _webhook_automation_for_actor(request: Request, ctx: AppContextDep, task_id: str) -> dict[str, Any]:
    actor = request_actor(request, ctx.auth_store)
    task = get_task_for_actor(ctx.task_store, task_id, actor)
    if not task.get("isRoutine") or not has_webhook(task):
        raise HTTPException(409, "automation_not_webhook")
    editors = {task.get("ownerUserId")} - {None}
    if not actor["isAdmin"] and actor.get("userId") not in editors:
        raise HTTPException(403, "Only the automation's owner or an admin can manage its webhook.")
    return task


@router.get("/tasks/{task_id}/automation/webhook-secret")
def webhook_secret_status(task_id: str, request: Request, ctx: AppContextDep) -> dict[str, Any]:
    _webhook_automation_for_actor(request, ctx, task_id)
    configured = request.app.state.automation_store.has_webhook_secret(task_id)
    return {"configured": configured, "path": webhook_path(task_id), "header": WEBHOOK_TOKEN_HEADER}


@router.post("/tasks/{task_id}/automation/webhook-secret", status_code=201)
def rotate_webhook_secret(task_id: str, request: Request, ctx: AppContextDep) -> dict[str, Any]:
    _webhook_automation_for_actor(request, ctx, task_id)
    secret = request.app.state.automation_store.set_webhook_secret(task_id)
    return {"secret": secret, "path": webhook_path(task_id), "header": WEBHOOK_TOKEN_HEADER}


@router.post("/tasks/{task_id}/automation/resume")
async def resume_automation(task_id: str, request: Request, ctx: AppContextDep) -> dict[str, Any]:
    """Turn a paused automation back on (owner or admin)."""
    actor = await run_in_threadpool(request_actor, request, ctx.auth_store)
    task = await run_in_threadpool(get_task_for_actor, ctx.task_store, task_id, actor)
    if not task.get("isRoutine"):
        raise HTTPException(404, "Not an automation.")
    service = automation_service(request.app.state.automation_store, ctx)
    try:
        resumed = await run_in_threadpool(service.resume, task_id, actor, datetime.now(timezone.utc))
    except PermissionError as error:
        raise HTTPException(403, str(error)) from error
    except TriggerError as error:
        raise HTTPException(400, str(error)) from error
    return public_task_result(resumed)


@router.post("/automations/schedule-preview")
async def preview_schedule(request: Request, ctx: AppContextDep) -> dict[str, Any]:
    """The summary and next fires of a schedule, before it is saved."""
    await run_in_threadpool(request_actor, request, ctx.auth_store)
    body = await json_body(request)
    try:
        schedule = normalize_schedule(body.get("schedule"))
    except ScheduleError as error:
        raise HTTPException(400, str(error)) from error
    fires = next_fires(schedule, datetime.now(timezone.utc), PREVIEW_FIRES)
    return {"summary": summarize(schedule), "next": [fire.isoformat() for fire in fires]}
