"""The signed-in person's tag catalog (Settings → Tags).

Only a sign-in session reaches these routes: a catalog belongs to the User of
the session's Account and covers that User's own Tasks and Automations.
``relay/tags/catalog.py`` holds the rules; errors answer ``{"detail": code}``.
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, HTTPException, Request, Response

from ...security.request_auth import require_user_session
from ...tags.catalog import (
    TagCatalogError,
    apply_tag_operation,
    create_tag,
    list_tags,
    preview_tag_operation,
)
from ..bodies import JsonBodyDep
from ..deps import AppContextDep

router = APIRouter()


def _owner(request: Request, ctx: AppContextDep) -> str:
    account = require_user_session(request, ctx.auth_store)
    user_id = account.get("userId")
    if not isinstance(user_id, str) or not user_id:
        raise HTTPException(403, "tag_catalog_unavailable")
    return user_id


def _answer(error: TagCatalogError) -> HTTPException:
    return HTTPException(error.status, error.code)


@router.get("/account/tags")
def get_tags(request: Request, response: Response, ctx: AppContextDep) -> dict[str, Any]:
    owner = _owner(request, ctx)
    response.headers["Cache-Control"] = "no-store"
    query = request.query_params.get("query") or ""
    tags = list_tags(ctx.task_store, owner, query[:64])
    return {"tags": tags, "total": len(tags)}


@router.post("/account/tags", status_code=201)
def post_tag(request: Request, ctx: AppContextDep, *, _request_body: JsonBodyDep) -> dict[str, Any]:
    owner = _owner(request, ctx)
    try:
        return {"tag": create_tag(ctx.task_store, owner, _request_body.get("name"))}
    except TagCatalogError as error:
        raise _answer(error) from error


@router.post("/account/tags/preview")
def preview_tags(request: Request, ctx: AppContextDep, *, _request_body: JsonBodyDep) -> dict[str, Any]:
    owner = _owner(request, ctx)
    try:
        return preview_tag_operation(ctx.task_store, ctx.project_store, owner, _request_body)
    except TagCatalogError as error:
        raise _answer(error) from error


@router.post("/account/tags/apply")
def apply_tags(request: Request, ctx: AppContextDep, *, _request_body: JsonBodyDep) -> dict[str, Any]:
    owner = _owner(request, ctx)
    try:
        return apply_tag_operation(ctx.task_store, ctx.project_store, owner, _request_body)
    except TagCatalogError as error:
        raise _answer(error) from error
