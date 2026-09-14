from __future__ import annotations

import base64
import binascii
import json
from typing import Any

from fastapi import APIRouter, HTTPException, Request, Response
from starlette.concurrency import run_in_threadpool

from ..persistence.skill_store import (
    MAX_FILE_BYTES,
    MAX_FILES,
    MAX_REVISION_BYTES,
    SkillValidationError,
)
from ..services import skill_assignments, skill_grants, skill_import
from .deps import AppContextDep
from .helpers import request_actor

router = APIRouter()
# Base64 expands content by 4/3; reserve bounded space for paths and metadata.
MAX_SKILL_REQUEST_BYTES = ((MAX_REVISION_BYTES + 2) // 3) * 4 + 512 * 1024
_SIZE_ERRORS = {"file-too-large", "too-many-files", "revision-too-large"}


def skill_error(error: SkillValidationError) -> HTTPException:
    return HTTPException(413 if error.code in _SIZE_ERRORS else 422, error.code)


async def skill_body(request: Request, allowed: set[str]) -> dict[str, Any]:
    data = bytearray()
    async for chunk in request.stream():
        if len(data) + len(chunk) > MAX_SKILL_REQUEST_BYTES:
            raise HTTPException(413, "revision-too-large")
        data.extend(chunk)
    try:
        body = json.loads(data)
    except (ValueError, UnicodeError) as error:
        raise HTTPException(422, "invalid-json") from error
    if not isinstance(body, dict) or set(body) - allowed:
        raise HTTPException(422, "invalid-fields")
    return body


def decode_files(raw: Any) -> list[dict[str, Any]]:
    if not isinstance(raw, list):
        raise HTTPException(422, "invalid-files")
    if len(raw) > MAX_FILES:
        raise HTTPException(413, "too-many-files")
    files = []
    total = 0
    for entry in raw:
        if not isinstance(entry, dict) or set(entry) != {"path", "contentBase64"}:
            raise HTTPException(422, "invalid-file")
        encoded = entry["contentBase64"]
        if not isinstance(encoded, str) or not isinstance(entry["path"], str):
            raise HTTPException(422, "invalid-file")
        if len(encoded) > ((MAX_FILE_BYTES + 2) // 3) * 4:
            raise HTTPException(413, "file-too-large")
        try:
            content = base64.b64decode(encoded, validate=True)
        except (ValueError, binascii.Error) as error:
            raise HTTPException(422, "invalid-base64") from error
        if len(content) > MAX_FILE_BYTES:
            raise HTTPException(413, "file-too-large")
        total += len(content)
        if total > MAX_REVISION_BYTES:
            raise HTTPException(413, "revision-too-large")
        files.append({"path": entry["path"], "content": content})
    return files


def visible_skill(ctx: AppContextDep, skill_id: str, employee_id: str) -> dict[str, Any]:
    skill = ctx.skill_store.get_skill(skill_id)
    if skill is None or skill["deletedAt"] is not None:
        raise HTTPException(404, "skill-not-found")
    if skill["visibility"] != "org" and skill["ownerEmployeeId"] != employee_id:
        raise HTTPException(404, "skill-not-found")
    return skill


def owned_skill(ctx: AppContextDep, skill_id: str, employee_id: str) -> dict[str, Any]:
    skill = visible_skill(ctx, skill_id, employee_id)
    if skill["ownerEmployeeId"] != employee_id:
        raise HTTPException(403, "not-skill-owner")
    return skill


@router.get("/skills")
async def list_skills(request: Request, ctx: AppContextDep) -> dict[str, Any]:
    actor = request_actor(request, ctx.auth_store)
    agents = ctx.agent_store.list_agents(supervisor_employee_id=actor["employeeId"])
    counts: dict[str, int] = {}
    for agent in agents:
        for skill_id in {entry["skillId"] for entry in skill_grants.read_grants(agent)}:
            counts[skill_id] = counts.get(skill_id, 0) + 1
    assignment_counts: dict[str, int] = {}
    for assignment in ctx.skill_store.list_assignments():
        if assignment["createdByEmployeeId"] == actor["employeeId"] or actor["isAdmin"]:
            assignment_counts[assignment["skillId"]] = (
                assignment_counts.get(assignment["skillId"], 0) + 1
            )
    return {"skills": [
        {
            **skill,
            "grantedAgentCount": counts.get(skill["id"], 0),
            "assignmentCount": assignment_counts.get(skill["id"], 0),
        }
        for skill in ctx.skill_store.list_skills(actor["employeeId"])
    ]}


@router.post("/skills", status_code=201)
async def create_skill(request: Request, ctx: AppContextDep) -> dict[str, Any]:
    actor = request_actor(request, ctx.auth_store)
    body = await skill_body(request, {
        "name", "namespace", "displayName", "description", "visibility", "source", "files",
    })
    if body.get("source", "authored") not in ("authored", "upload"):
        raise HTTPException(422, "invalid-source")
    payload = {**body, "source": body.get("source", "authored"), "files": decode_files(body.get("files"))}
    # The authenticated identity supplies the collision suffix; callers cannot
    # impersonate another publisher by providing ownerHandle in the request.
    payload["ownerHandle"] = actor["employeeId"]
    try:
        return ctx.skill_store.create_skill(actor["employeeId"], payload)
    except SkillValidationError as error:
        raise skill_error(error) from error


@router.get("/skills/{skill_id}")
async def get_skill(skill_id: str, request: Request, ctx: AppContextDep) -> dict[str, Any]:
    actor = request_actor(request, ctx.auth_store)
    skill = visible_skill(ctx, skill_id, actor["employeeId"])
    return {
        **skill,
        "grantedAgentIds": [
            agent["id"] for agent in ctx.agent_store.list_agents(supervisor_employee_id=actor["employeeId"])
            if any(entry["skillId"] == skill_id for entry in skill_grants.read_grants(agent))
        ],
        "revisions": ctx.skill_store.list_revisions(skill_id),
        "assignments": [
            assignment
            for assignment in ctx.skill_store.list_assignments(skill_id=skill_id)
            if actor["isAdmin"]
            or assignment["createdByEmployeeId"] == actor["employeeId"]
        ],
        "files": [
            {key: entry[key] for key in ("path", "sha256", "bytes")}
            for entry in ctx.skill_store.revision_files(skill["currentRevisionId"])
        ],
    }


async def import_files(ctx: AppContextDep, source: dict[str, Any]) -> list[dict[str, Any]]:
    if not isinstance(source.get("url"), str) or not isinstance(source.get("ref"), str):
        raise HTTPException(422, "invalid-source-ref")
    if not isinstance(source.get("subpath", ""), str):
        raise HTTPException(422, "invalid-subpath")
    try:
        return await run_in_threadpool(
            skill_import.fetch_skill_bundle, source["url"], source["ref"], source.get("subpath", ""),
            allowed_hosts=ctx.org_settings_store.get_settings()["skillImportAllowedHosts"],
        )
    except skill_import.SkillImportError as error:
        size_errors = _SIZE_ERRORS | {"archive-too-large", "bundle-too-large"}
        raise HTTPException(413 if error.code in size_errors else 422, error.code) from error


@router.post("/skills/import", status_code=201)
async def import_skill(request: Request, ctx: AppContextDep) -> dict[str, Any]:
    actor = request_actor(request, ctx.auth_store)
    body = await skill_body(request, {
        "name", "namespace", "displayName", "description", "visibility", "url", "ref", "subpath",
    })
    source = {"url": body.get("url"), "ref": body.get("ref", "HEAD"), "subpath": body.get("subpath", "")}
    files = await import_files(ctx, source)
    payload = {key: value for key, value in body.items() if key not in source}
    payload.update(source="git", sourceRef=source, files=files, ownerHandle=actor["employeeId"])
    try:
        return ctx.skill_store.create_skill(actor["employeeId"], payload)
    except SkillValidationError as error:
        raise skill_error(error) from error


@router.post("/skills/{skill_id}/import", status_code=201)
async def reimport_skill(skill_id: str, request: Request, ctx: AppContextDep) -> dict[str, Any]:
    actor = request_actor(request, ctx.auth_store)
    skill = owned_skill(ctx, skill_id, actor["employeeId"])
    if skill["source"] != "git" or not isinstance(skill.get("sourceRef"), dict):
        raise HTTPException(422, "not-git-source")
    files = await import_files(ctx, skill["sourceRef"])
    try:
        return ctx.skill_store.add_revision(skill_id, actor["employeeId"], files, "Re-imported from Git")
    except SkillValidationError as error:
        raise skill_error(error) from error
    except KeyError as error:
        raise HTTPException(404, "skill-not-found") from error


@router.post("/skills/{skill_id}/revisions", status_code=201)
async def add_revision(skill_id: str, request: Request, ctx: AppContextDep) -> dict[str, Any]:
    actor = request_actor(request, ctx.auth_store)
    owned_skill(ctx, skill_id, actor["employeeId"])
    body = await skill_body(request, {"files", "note"})
    if body.get("note") is not None and (not isinstance(body["note"], str) or len(body["note"]) > 4096):
        raise HTTPException(422, "invalid-note")
    files = decode_files(body.get("files"))
    try:
        return ctx.skill_store.add_revision(skill_id, actor["employeeId"], files, body.get("note"))
    except SkillValidationError as error:
        raise skill_error(error) from error
    except KeyError as error:
        raise HTTPException(404, "skill-not-found") from error


@router.patch("/skills/{skill_id}")
async def update_skill(skill_id: str, request: Request, ctx: AppContextDep) -> dict[str, Any]:
    actor = request_actor(request, ctx.auth_store)
    owned_skill(ctx, skill_id, actor["employeeId"])
    body = await skill_body(request, {"displayName", "description", "visibility"})
    try:
        return ctx.skill_store.update_skill(skill_id, body)
    except SkillValidationError as error:
        raise skill_error(error) from error
    except KeyError as error:
        raise HTTPException(404, "skill-not-found") from error


@router.delete("/skills/{skill_id}", status_code=204)
async def delete_skill(skill_id: str, request: Request, ctx: AppContextDep) -> Response:
    actor = request_actor(request, ctx.auth_store)
    owned_skill(ctx, skill_id, actor["employeeId"])
    ctx.skill_store.delete_skill(skill_id)
    return Response(status_code=204)


def grant_error(error: skill_grants.SkillGrantError) -> HTTPException:
    status = {"not-agent-owner": 403, "skill-not-found": 404, "agent-not-found": 404}.get(error.code, 422)
    return HTTPException(status, error.code)


def assignment_error(error: skill_assignments.SkillAssignmentError) -> HTTPException:
    status = {
        "not-target-owner": 403,
        "skill-not-found": 404,
        "assignment-not-found": 404,
        "assignment-target-not-found": 404,
    }.get(error.code, 422)
    return HTTPException(status, error.code)


@router.post("/skills/{skill_id}/assignments", status_code=201)
async def assign_skill(
    skill_id: str, request: Request, ctx: AppContextDep
) -> dict[str, Any]:
    actor = request_actor(request, ctx.auth_store)
    body = await skill_body(
        request, {"targetType", "targetId", "mode", "pin", "invocation"}
    )
    if not isinstance(body.get("targetType"), str) or not isinstance(
        body.get("targetId"), str
    ):
        raise HTTPException(422, "invalid-assignment-target")
    try:
        return skill_assignments.assign(
            ctx,
            skill_id,
            body["targetType"],
            body["targetId"],
            actor["employeeId"],
            mode=body.get("mode", "optional"),
            pin=body.get("pin", "stable"),
            invocation=body.get("invocation", "implicit"),
            actor_is_admin=actor["isAdmin"],
        )
    except skill_assignments.SkillAssignmentError as error:
        raise assignment_error(error) from error


@router.delete("/skills/{skill_id}/assignments/{assignment_id}", status_code=204)
async def revoke_assignment(
    skill_id: str, assignment_id: str, request: Request, ctx: AppContextDep
) -> Response:
    actor = request_actor(request, ctx.auth_store)
    assignment = ctx.skill_store.get_assignment(assignment_id)
    if not assignment or assignment["skillId"] != skill_id:
        raise HTTPException(404, "assignment-not-found")
    try:
        skill_assignments.revoke(
            ctx,
            assignment_id,
            actor["employeeId"],
            actor_is_admin=actor["isAdmin"],
        )
    except skill_assignments.SkillAssignmentError as error:
        raise assignment_error(error) from error
    return Response(status_code=204)


@router.post("/skills/{skill_id}/grants")
async def grant_skill(skill_id: str, request: Request, ctx: AppContextDep) -> dict[str, Any]:
    actor = request_actor(request, ctx.auth_store)
    body = await skill_body(request, {"agentIds", "pin"})
    agent_ids = body.get("agentIds")
    if not isinstance(agent_ids, list) or len(agent_ids) > 300:
        raise HTTPException(422, "invalid-agent-ids")
    try:
        granted = skill_grants.grant(ctx, skill_id, agent_ids, actor["employeeId"], body.get("pin", "latest"))
    except skill_grants.SkillGrantError as error:
        raise grant_error(error) from error
    return {"granted": granted}


@router.delete("/skills/{skill_id}/grants/{agent_id}", status_code=204)
async def revoke_skill(skill_id: str, agent_id: str, request: Request, ctx: AppContextDep) -> Response:
    actor = request_actor(request, ctx.auth_store)
    try:
        skill_grants.revoke(ctx, skill_id, agent_id, actor["employeeId"])
    except skill_grants.SkillGrantError as error:
        raise grant_error(error) from error
    return Response(status_code=204)
