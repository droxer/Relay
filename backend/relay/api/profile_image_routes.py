from __future__ import annotations

from typing import Any

from fastapi import APIRouter, HTTPException, Request, Response

from ..core.preset_avatars import is_preset_avatar_url
from ..persistence.profile_image_store import ProfileImageError
from .agent_routes import _agent_with_placements
from .deps import AppContextDep
from .helpers import JsonBodyDep, request_actor
from .team_routes import _team_view

router = APIRouter()


def _profile_entity(
    request: Request,
    ctx: AppContextDep,
    kind: str,
    entity_id: str,
) -> tuple[dict[str, Any], str]:
    actor = request_actor(request, ctx.auth_store)
    if kind == "agents":
        entity = ctx.agent_store.get_agent(entity_id)
        owner_id = entity.get("supervisorEmployeeId") if entity else None
    elif kind == "teams":
        entity = ctx.team_store.get_team(entity_id)
        owner_id = entity.get("ownerEmployeeId") if entity else None
    else:
        raise HTTPException(404, "Profile image not found.")
    if not entity or entity.get("deletedAt"):
        raise HTTPException(404, "Profile not found.")
    if not actor["isAdmin"] and owner_id != actor["employeeId"]:
        raise HTTPException(403, "Cannot access another employee's profile image.")
    return entity, owner_id


def _profile_image_error(error: ProfileImageError) -> HTTPException:
    return HTTPException(400, str(error))


@router.get("/profile-images/{kind}/{entity_id}")
def get_profile_image(
    kind: str,
    entity_id: str,
    request: Request,
    ctx: AppContextDep,
) -> Response:
    _profile_entity(request, ctx, kind, entity_id)
    try:
        stored = ctx.profile_image_store.read(kind, entity_id)
    except ProfileImageError as error:
        raise HTTPException(404, "Profile image not found.") from error
    if not stored:
        raise HTTPException(404, "Profile image not found.")
    content, content_type, etag = stored
    if request.headers.get("if-none-match") == f'"{etag}"':
        return Response(status_code=304)
    return Response(
        content,
        media_type=content_type,
        headers={
            "Cache-Control": "private, max-age=31536000, immutable",
            "ETag": f'"{etag}"',
            "X-Content-Type-Options": "nosniff",
        },
    )


@router.put("/profile-images/{kind}/{entity_id}")
def update_profile_image(
    kind: str,
    entity_id: str,
    request: Request,
    ctx: AppContextDep,
    *,
    _request_body: JsonBodyDep,
) -> dict[str, Any]:
    _profile_entity(request, ctx, kind, entity_id)
    body = _request_body
    if "presetUrl" in body:
        return _apply_preset(ctx, kind, entity_id, body.get("presetUrl"))
    try:
        image_url = ctx.profile_image_store.save(kind, entity_id, body.get("dataUrl"))
        return _set_profile_image_url(ctx, kind, entity_id, image_url)
    except ProfileImageError as error:
        raise _profile_image_error(error) from error
    except (KeyError, ValueError) as error:
        ctx.profile_image_store.delete(kind, entity_id)
        raise HTTPException(400, str(error)) from error


def _apply_preset(
    ctx: AppContextDep, kind: str, entity_id: str, preset_url: object
) -> dict[str, Any]:
    """Point the profile at a bundled preset and drop any uploaded file it replaces."""
    if not is_preset_avatar_url(kind, preset_url):
        raise HTTPException(400, "profile_image_preset")
    try:
        result = _set_profile_image_url(ctx, kind, entity_id, preset_url)
    except (KeyError, ValueError) as error:
        raise HTTPException(400, str(error)) from error
    ctx.profile_image_store.delete(kind, entity_id)
    return result


def _set_profile_image_url(
    ctx: AppContextDep, kind: str, entity_id: str, image_url: object
) -> dict[str, Any]:
    if kind == "agents":
        updated = ctx.agent_store.update_agent(entity_id, {"profileImageUrl": image_url})
        return {"agent": _agent_with_placements(ctx, updated)}
    updated = ctx.team_store.update_team(entity_id, {"profileImageUrl": image_url})
    return {"team": _team_view(ctx, updated)}


@router.delete("/profile-images/{kind}/{entity_id}")
def delete_profile_image(
    kind: str,
    entity_id: str,
    request: Request,
    ctx: AppContextDep,
) -> dict[str, Any]:
    _profile_entity(request, ctx, kind, entity_id)
    try:
        if kind == "agents":
            updated = ctx.agent_store.update_agent(
                entity_id, {"profileImageUrl": None}
            )
            result = {"agent": _agent_with_placements(ctx, updated)}
        else:
            updated = ctx.team_store.update_team(
                entity_id, {"profileImageUrl": None}
            )
            result = {"team": _team_view(ctx, updated)}
        ctx.profile_image_store.delete(kind, entity_id)
        return result
    except ProfileImageError as error:
        raise _profile_image_error(error) from error
