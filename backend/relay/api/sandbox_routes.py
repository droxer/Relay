from __future__ import annotations

from typing import Any

from fastapi import APIRouter, HTTPException, Request
from loguru import logger

from ..core.computer_identity import computer_id
from ..daemon_registry import (
    provisioned_sandbox_record,
    public_sandbox_record,
    sandbox_ui_auth_error,
    sandbox_ui_token_matches,
)
from ..persistence.agent_placement_store import create_node_placement
from ..services.computer_names import present_computer
from .deps import AppContextDep
from .helpers import (
    actor_can_access_sandbox,
    assignment_list,
    bearer_token,
    json_body,
    request_actor_or_none,
    string_field,
)

router = APIRouter()


def public_computer_record(
    ctx: AppContextDep, sandbox: dict[str, Any]
) -> dict[str, Any]:
    return present_computer(ctx, public_sandbox_record(sandbox))


def require_sandbox_access(
    sandbox: dict[str, Any], request: Request, ctx: AppContextDep
) -> dict[str, Any] | None:
    token = bearer_token(request)
    if token and sandbox_ui_token_matches(sandbox, token):
        return None
    actor = request_actor_or_none(request, ctx.auth_store)
    if actor:
        if not actor_can_access_sandbox(actor, sandbox):
            raise HTTPException(403, "Sandbox access denied.")
        return actor
    auth_error = sandbox_ui_auth_error(sandbox, token)
    if auth_error:
        raise HTTPException(401, auth_error)
    return None


@router.get("/sandboxes")
def sandboxes(request: Request, ctx: AppContextDep) -> dict[str, Any]:
    token = bearer_token(request)
    if token:
        allowed = [
            public_computer_record(ctx, sandbox)
            for sandbox in ctx.backend.list()
            if sandbox_ui_token_matches(sandbox, token)
        ]
        if allowed:
            return {"sandboxes": allowed}
    actor = request_actor_or_none(request, ctx.auth_store)
    if actor:
        allowed = [
            public_computer_record(ctx, sandbox)
            for sandbox in ctx.backend.list()
            if actor_can_access_sandbox(actor, sandbox)
        ]
        return {"sandboxes": allowed}
    raise HTTPException(401, "Authentication required.")


@router.post("/sandboxes", status_code=201)
async def provision_sandbox(request: Request, ctx: AppContextDep) -> dict[str, Any]:
    body = await json_body(request)
    employee_id = string_field(body, "employeeId")
    if not employee_id:
        raise HTTPException(400, "employeeId is required.")
    actor = request_actor_or_none(request, ctx.auth_store)
    if not actor:
        raise HTTPException(401, "Authentication required.")
    if not actor["isAdmin"] and employee_id != actor["employeeId"]:
        raise HTTPException(403, "Sandbox access denied.")
    try:
        sandbox = ctx.backend.provision(
            {
                "employeeId": employee_id,
                "sandboxId": string_field(body, "sandboxId") or None,
                "workspacePath": string_field(body, "workspacePath") or None,
                "token": bearer_token(request),
                "nodeToken": string_field(body, "nodeToken") or None,
                "actorEmployeeId": actor["employeeId"],
                "actorIsAdmin": actor["isAdmin"],
            }
        )
        logger.info(
            "Sandbox provisioned", sandbox_id=sandbox["id"], employee_id=employee_id
        )
        return present_computer(ctx, provisioned_sandbox_record(sandbox))
    except PermissionError as error:
        logger.warning(
            "Sandbox provisioning denied", employee_id=employee_id, error=str(error)
        )
        raise HTTPException(403, str(error))


@router.get("/sandboxes/{sandbox_id}")
async def get_sandbox(
    sandbox_id: str, request: Request, ctx: AppContextDep
) -> dict[str, Any]:
    sandbox = ctx.backend.get(sandbox_id)
    if not sandbox:
        raise HTTPException(404, "Sandbox not found.")
    require_sandbox_access(sandbox, request, ctx)
    return public_computer_record(ctx, sandbox)


@router.post("/sandboxes/{sandbox_id}/runs", status_code=202)
async def run_sandbox(
    sandbox_id: str, request: Request, ctx: AppContextDep
) -> dict[str, Any]:
    sandbox = ctx.backend.get(sandbox_id)
    if not sandbox:
        raise HTTPException(404, "Sandbox not found.")
    actor = require_sandbox_access(sandbox, request, ctx)
    body = await json_body(request)
    task_goal = string_field(body, "taskGoal") or string_field(body, "task_goal")
    assignments = assignment_list(body.get("assignments"))
    if not task_goal or not assignments:
        raise HTTPException(400, "taskGoal and at least one assignment are required.")
    session_id = string_field(body, "sessionId") or string_field(body, "session_id")
    employee_id = sandbox.get("employeeId")
    if employee_id and session_id and actor and actor.get("isAdmin"):
        session = ctx.session_store.get_session(session_id)
        employee_id = session.get("ownerEmployeeId") or employee_id
    if employee_id:
        assignments = [
            _resolve_legacy_assignment(ctx, employee_id, sandbox_id, assignment)
            for assignment in assignments
        ]
    parsed: dict[str, Any] = {
        "taskGoal": task_goal,
        "assignments": assignments,
        **({"agentFirst": True} if employee_id else {}),
    }
    if session_id:
        parsed["sessionId"] = session_id
    user_message_id = string_field(body, "userMessageId") or string_field(
        body, "user_message_id"
    )
    if user_message_id:
        parsed["userMessageId"] = user_message_id
    decision = body.get("decision")
    if isinstance(decision, dict):
        parsed_decision = {
            "kind": string_field(decision, "kind"),
            "note": string_field(decision, "note") or None,
            "targetAgent": string_field(decision, "targetAgent")
            or string_field(decision, "target_agent")
            or None,
            "targetAgentId": string_field(decision, "targetAgentId")
            or string_field(decision, "target_agent_id")
            or None,
        }
        parsed["decision"] = {
            key: value for key, value in parsed_decision.items() if value
        }
    if actor:
        parsed["actorEmployeeId"] = actor["employeeId"]
        parsed["actorIsAdmin"] = actor["isAdmin"]
    logger.info(
        "Sandbox run starting",
        sandbox_id=sandbox_id,
        session_id=parsed.get("sessionId"),
    )
    try:
        return await ctx.backend.run(sandbox_id, parsed)
    except PermissionError as error:
        raise HTTPException(403, str(error))
    except ValueError as error:
        raise HTTPException(409, str(error))


def _resolve_legacy_assignment(
    ctx: AppContextDep,
    employee_id: str,
    sandbox_id: str,
    assignment: dict[str, Any],
) -> dict[str, Any]:
    node = ctx.registry.get(sandbox_id)
    node_computer_id = computer_id(node or {"id": sandbox_id})
    agent = ctx.agent_store.ensure_compatibility_agent(
        employee_id,
        assignment["agent"],
        sandbox_id,
        computer_id=node_computer_id,
    )
    placement = next(
        (
            item
            for item in ctx.agent_placement_store.list_placements(agent_id=agent["id"])
            if item.get("computerId") == node_computer_id
            or (
                not item.get("computerId") and item["daemonNodeId"] == sandbox_id
            )
        ),
        None,
    )
    if placement is None:
        placement = create_node_placement(
            ctx.agent_placement_store, agent, node or {"id": sandbox_id}
        )
    return {
        **assignment,
        "agentId": agent["id"],
        "agentVersion": agent["version"],
        "placementId": placement["id"],
        "daemonNodeId": sandbox_id,
    }
