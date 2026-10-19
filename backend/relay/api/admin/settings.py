from __future__ import annotations

from typing import Any

from fastapi import APIRouter, HTTPException, Request

from ...automations.service import automation_triggers_enabled
from ...core.deploy_config import trusted_web_origin
from ...persistence.org.settings import (
    OrgSettingsValidationError,
    normalize_max_local_computers,
    normalize_max_task_rounds,
    normalize_skill_import_hosts,
)
from ...security.admin_token import admin_token_configured, reissue_admin_token
from ...security.request_auth import require_admin_session
from ..bodies import JsonBodyDep
from ..deps import AppContextDep

router = APIRouter()


@router.get("/admin/control-plane/metrics")
def control_plane_metrics(request: Request, ctx: AppContextDep) -> dict[str, Any]:
    require_admin_session(request, ctx.auth_store)
    bridge = ctx.notification_bridge
    return {
        "notifications": ctx.control_plane_notifier.stats(),
        "notificationBridge": (
            bridge.stats()
            if bridge is not None
            else {"enabled": False, "connected": False}
        ),
    }


@router.get("/admin/settings")
def get_org_settings(request: Request, ctx: AppContextDep) -> dict[str, Any]:
    require_admin_session(request, ctx.auth_store)
    return {
        "settings": ctx.org_settings_store.get_settings(),
        "capabilities": {
            # Always on since accounts are database-only; kept because the
            # admin UI still reads it to decide whether to offer user edits.
            "userEdits": True,
            # Off: automations may hold only schedule triggers.
            "automationTriggers": automation_triggers_enabled(),
            # Off: the public join is not mounted (RELAY_WAITLIST_ENABLED), so
            # nobody can ask; admins can still invite people directly.
            "waitlist": ctx.settings.waitlist_enabled,
            # Whether an invite goes out by email: switched on
            # (RELAY_WAITLIST_INVITE_EMAIL), mail configured, and a public web
            # origin to link to. Off, the admin copies the link.
            "inviteEmail": ctx.waitlist.invite_email_enabled and trusted_web_origin() is not None,
        },
        # Whether the bootstrap/supervisor bearer token exists. Only its hash
        # is stored, so the value itself is shown once, by the reissue route.
        "adminTokenConfigured": admin_token_configured(),
    }


@router.post("/admin/admin-token/reissue")
def reissue_admin_token_route(request: Request, ctx: AppContextDep) -> dict[str, Any]:
    require_admin_session(request, ctx.auth_store)
    try:
        token = reissue_admin_token()
    except ValueError as error:
        raise HTTPException(409, str(error)) from error
    return {"adminToken": token}


@router.put("/admin/settings")
def update_org_settings(
    request: Request, ctx: AppContextDep, *, _request_body: JsonBodyDep
) -> dict[str, Any]:
    require_admin_session(request, ctx.auth_store)
    body = _request_body
    if not {"maxLocalComputersPerUser", "maxTaskRounds", "skillImportAllowedHosts"}.intersection(body):
        raise HTTPException(
            400, "maxLocalComputersPerUser, maxTaskRounds or skillImportAllowedHosts is required."
        )
    try:
        settings = ctx.org_settings_store.update_settings(
            max_local_computers_per_user=(
                normalize_max_local_computers(body["maxLocalComputersPerUser"])
                if "maxLocalComputersPerUser" in body
                else None
            ),
            max_task_rounds=(
                normalize_max_task_rounds(body["maxTaskRounds"])
                if "maxTaskRounds" in body
                else None
            ),
            skill_import_allowed_hosts=(
                normalize_skill_import_hosts(body["skillImportAllowedHosts"])
                if "skillImportAllowedHosts" in body else None
            ),
        )
    except OrgSettingsValidationError as error:
        raise HTTPException(400, str(error)) from error
    return {"settings": settings}
