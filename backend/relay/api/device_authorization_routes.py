"""Browser-approved local Computer enrollment, with one-time token exchange."""
from __future__ import annotations

import hashlib
import shlex
import secrets
from datetime import datetime, timedelta, timezone
from urllib.parse import quote
from typing import Any

from fastapi import APIRouter, HTTPException, Request, Response
from sqlalchemy import delete, insert, select, update

from ..persistence.store_common import store_transaction
from ..security.device_authorization import computer_authorizations as grants
from .auth_routes import _consume_auth_attempt, _auth_rate_key
from .daemon_node_routes import create_local_device_enrollment
from .deps import AppContextDep
from .helpers import JsonBodyDep, backend_base_url, request_actor, valid_employee_workspace_path

router = APIRouter()
TTL_SECONDS = 600


def _human(request: Request, ctx: AppContextDep) -> dict[str, Any]:
    actor = request_actor(request, ctx.auth_store)
    if not actor.get("user"):
        raise HTTPException(401, "Sign in to connect a computer.")
    return actor


def _current(conn: Any, code: str) -> Any:
    row = conn.execute(select(grants).where(grants.c.user_code == code).where(
        grants.c.expires_at > datetime.now(timezone.utc)).with_for_update()).mappings().first()
    if not row:
        raise HTTPException(410, "This connection request has expired. Run setup again.")
    return row


@router.get("/computer-authorizations/setup-command")
def setup_command(request: Request, ctx: AppContextDep) -> dict[str, str]:
    _human(request, ctx)
    origin = backend_base_url(request)
    return {"installCommand": f"curl -fsSL {shlex.quote(origin + '/computer/install.sh')} | sh -s -- --backend-url {shlex.quote(origin)}"}


@router.post("/computer-authorizations", status_code=201)
def start_authorization(request: Request, ctx: AppContextDep, response: Response, *, _request_body: JsonBodyDep) -> dict[str, Any]:
    _consume_auth_attempt(request, _auth_rate_key(request, "computer-start"))
    path = _request_body.get("workspacePath")
    name = _request_body.get("displayName")
    if not isinstance(path, str) or len(path) > 4096 or any(ord(c) < 32 for c in path) or not valid_employee_workspace_path(path):
        raise HTTPException(400, "An absolute local workspace path is required.")
    if not isinstance(name, str) or not name.strip() or len(name) > 80 or any(ord(c) < 32 for c in name):
        raise HTTPException(400, "A computer name of at most 80 characters is required.")
    device_code, user_code = secrets.token_urlsafe(32), secrets.token_urlsafe(24)
    now = datetime.now(timezone.utc)
    with store_transaction(ctx.session_store.engine) as conn:
        conn.execute(delete(grants).where(grants.c.expires_at <= now))
        conn.execute(insert(grants).values(device_hash=hashlib.sha256(device_code.encode()).hexdigest(),
            user_code=user_code, expires_at=now + timedelta(seconds=TTL_SECONDS), status="pending",
            workspace_path=path, display_name=name.strip()))
    response.headers["Cache-Control"] = "no-store"
    return {"deviceCode": device_code, "userCode": user_code, "expiresIn": TTL_SECONDS,
            "verificationUrl": f"{backend_base_url(request)}/settings/computers?connect={quote(user_code)}"}


@router.post("/computer-authorizations/token")
def redeem_authorization(request: Request, ctx: AppContextDep, response: Response) -> dict[str, Any]:
    scheme, _, code = request.headers.get("Authorization", "").partition(" ")
    if scheme != "Device" or not code or len(code) > 128:
        raise HTTPException(401, "Invalid device credential.")
    digest = hashlib.sha256(code.encode()).hexdigest()
    with store_transaction(ctx.session_store.engine) as conn:
        row = conn.execute(select(grants).where(grants.c.device_hash == digest).where(
            grants.c.expires_at > datetime.now(timezone.utc)).with_for_update()).mappings().first()
        if not row:
            raise HTTPException(401, "Invalid or expired device credential.")
        response.headers["Cache-Control"] = "no-store"
        if row["status"] == "pending":
            response.status_code = 202
            return {"status": "pending"}
        if row["status"] != "approved":
            raise HTTPException(410, "This device credential has already been used.")
        node = ctx.registry.get(row["node_id"])
        if not node or node.get("status") == "deleted" or node.get("employeeId") != row["employee_id"]:
            raise HTTPException(410, "Computer authorization is no longer available.")
        token = node.get("nodeTokenSecret")
        if not token:
            raise HTTPException(409, "Computer credential is unavailable. Run setup again.")
        consumed = conn.execute(update(grants).where(grants.c.device_hash == digest).where(
            grants.c.status == "approved").values(status="consumed"))
        if consumed.rowcount != 1:
            raise HTTPException(410, "This device credential has already been used.")
        return {"sandboxId": node["id"], "employeeId": row["employee_id"], "token": token,
                "workspacePath": row["workspace_path"]}


@router.get("/computer-authorizations/{code}")
def authorization_details(code: str, request: Request, ctx: AppContextDep, response: Response) -> dict[str, Any]:
    _human(request, ctx)
    with store_transaction(ctx.session_store.engine) as conn:
        row = _current(conn, code)
        response.headers["Cache-Control"] = "no-store"
        return {"displayName": row["display_name"], "workspacePath": row["workspace_path"], "status": row["status"]}


@router.post("/computer-authorizations/{code}/approve")
def approve_authorization(code: str, request: Request, ctx: AppContextDep) -> dict[str, Any]:
    actor = _human(request, ctx)
    _consume_auth_attempt(request, _auth_rate_key(request, "computer-approve", actor["employeeId"]))
    with store_transaction(ctx.session_store.engine) as conn:
        row = _current(conn, code)
        if row["status"] != "pending":
            raise HTTPException(409, "This connection request has already been approved.")
        claimed = conn.execute(update(grants).where(grants.c.device_hash == row["device_hash"]).where(
            grants.c.status == "pending").values(status="approved"))
        if claimed.rowcount != 1:
            raise HTTPException(409, "This connection request has already been approved.")
        enrolled = create_local_device_enrollment(request, ctx, _request_body={
            "workspacePath": row["workspace_path"], "displayName": row["display_name"], "sandboxMode": "none"})
        conn.execute(update(grants).where(grants.c.device_hash == row["device_hash"]).values(
            node_id=enrolled["node"]["id"], employee_id=actor["employeeId"]))
    return {"status": "approved"}
