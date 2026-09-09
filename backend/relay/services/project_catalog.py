from __future__ import annotations

from typing import Any

from ..core.computer_identity import computer_id
from ..core.models import AGENT_ROLES
from ..persistence.project_store import ProjectValidationError

PROJECT_NAME_MAX_LENGTH = 120
PROJECT_MEMBER_MAX_COUNT = 32
PROJECT_FUNCTION_TITLE_MAX_LENGTH = 120
PROJECT_RESPONSIBILITIES_MAX_LENGTH = 4_000
PROJECT_INSTRUCTIONS_MAX_LENGTH = 8_000


def create_project_payload(
    owner_employee_id: str,
    payload: dict[str, Any],
    *,
    registry: Any,
    agent_store: Any,
    placement_store: Any,
) -> dict[str, Any]:
    node_id = _required_text(payload.get("daemonNodeId"), "project_computer_required")
    node = registry.get(node_id)
    if not node or node.get("retiredAt"):
        raise ProjectValidationError("project_computer_not_found")
    if node.get("employeeId") != owner_employee_id:
        raise ProjectValidationError("project_computer_forbidden")
    if not node.get("workspacePath"):
        raise ProjectValidationError("project_workspace_unavailable")
    if "project-workspaces" not in (node.get("capabilities") or []):
        raise ProjectValidationError("project_workspace_unsupported")
    target_computer_id = computer_id(node)
    members, lead_agent_id = validate_project_roster(
        owner_employee_id,
        payload.get("members"),
        payload.get("leadAgentId"),
        target_computer_id=target_computer_id,
        target_node_id=node["id"],
        agent_store=agent_store,
        placement_store=placement_store,
    )
    enabled = payload.get("enabled", True)
    if not isinstance(enabled, bool):
        raise ProjectValidationError("project_enabled_invalid")
    return {
        "name": _required_text(
            payload.get("name"),
            "project_name_required",
            max_length=PROJECT_NAME_MAX_LENGTH,
        ),
        "computerId": target_computer_id,
        "leadAgentId": lead_agent_id,
        "members": members,
        "enabled": enabled,
    }


def resolve_target_node_id(monitor_nodes: list[dict[str, Any]], computer_id_value: str) -> str | None:
    """Find the live daemon node currently hosting a project's computer.

    Legacy placements predate stable computer ids, so roster validation
    falls back to matching the daemon node currently hosting the project's
    computer, the same lookup `create_project_payload` performs up front.
    """
    return next(
        (
            node["id"]
            for node in monitor_nodes
            if not node.get("retiredAt") and computer_id(node) == computer_id_value
        ),
        None,
    )


def update_project_payload(
    owner_employee_id: str,
    current: dict[str, Any],
    payload: dict[str, Any],
    *,
    agent_store: Any,
    placement_store: Any,
    target_node_id: str | None = None,
) -> tuple[dict[str, Any], int]:
    expected_version = payload.get("expectedVersion")
    if not isinstance(expected_version, int) or isinstance(expected_version, bool):
        raise ProjectValidationError("project_expected_version_required")
    allowed = {"name", "leadAgentId", "members", "enabled", "expectedVersion"}
    if set(payload) - allowed:
        raise ProjectValidationError("project_patch_unsupported")
    patch = {key: value for key, value in payload.items() if key != "expectedVersion"}
    if "name" in patch:
        patch["name"] = _required_text(
            patch["name"],
            "project_name_required",
            max_length=PROJECT_NAME_MAX_LENGTH,
        )
    if "members" in patch or "leadAgentId" in patch:
        members, lead_agent_id = validate_project_roster(
            owner_employee_id,
            patch.get("members", current["members"]),
            patch.get("leadAgentId", current["leadAgentId"]),
            target_computer_id=current["computerId"],
            # Create resolves the node's id up front; updates must do the same
            # (via the caller) or legacy placements — those recorded before
            # placements carried a stable computerId — can never revalidate,
            # which locks the roster of every pre-computerId project.
            target_node_id=target_node_id,
            agent_store=agent_store,
            placement_store=placement_store,
        )
        if "members" in patch:
            patch["members"] = members
        # Clearing the last member also clears its lead, even when the caller
        # only supplies members. Keep the roster and lead as one valid update.
        patch["leadAgentId"] = lead_agent_id
    return patch, expected_version


def validate_project_roster(
    owner_employee_id: str,
    raw_members: Any,
    lead_agent_id: Any,
    *,
    target_computer_id: str,
    target_node_id: str | None,
    agent_store: Any,
    placement_store: Any,
) -> tuple[list[dict[str, Any]], str | None]:
    if not isinstance(raw_members, list):
        raise ProjectValidationError("project_members_required")
    if not raw_members:
        return [], None
    if len(raw_members) > PROJECT_MEMBER_MAX_COUNT:
        raise ProjectValidationError("project_members_too_many")
    members = [_normalize_member(member) for member in raw_members]
    agent_ids = [member["agentId"] for member in members]
    if len(set(agent_ids)) != len(agent_ids):
        raise ProjectValidationError("project_members_duplicate")
    if not isinstance(lead_agent_id, str) or lead_agent_id not in agent_ids:
        raise ProjectValidationError("project_lead_not_member")
    lead = next(member for member in members if member["agentId"] == lead_agent_id)
    if not lead.get("enabled", True):
        raise ProjectValidationError("project_lead_disabled")
    for member in members:
        agent = agent_store.get_agent(member["agentId"])
        if not agent or agent.get("deletedAt"):
            raise ProjectValidationError("project_member_not_found")
        if agent.get("supervisorEmployeeId") != owner_employee_id:
            raise ProjectValidationError("project_member_wrong_owner")
        if not agent.get("enabled", True):
            raise ProjectValidationError("project_member_disabled")
        placements = placement_store.list_placements(agent_id=agent["id"])
        if not any(
            placement.get("desiredState") == "active"
            and (
                placement.get("computerId") == target_computer_id
                or (
                    not placement.get("computerId")
                    and target_node_id is not None
                    and placement.get("daemonNodeId") == target_node_id
                )
            )
            for placement in placements
        ):
            raise ProjectValidationError("project_member_computer_mismatch")
    return members, lead_agent_id


def _normalize_member(value: Any) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise ProjectValidationError("project_member_invalid")
    allowed = {
        "agentId",
        "role",
        "functionTitle",
        "responsibilities",
        "instructions",
        "enabled",
    }
    if set(value) - allowed:
        raise ProjectValidationError("project_member_invalid")
    agent_id = _required_text(value.get("agentId"), "project_member_not_found")
    role = _required_text(value.get("role"), "project_role_invalid")
    if role not in AGENT_ROLES:
        raise ProjectValidationError("project_role_invalid")
    enabled = value.get("enabled", True)
    if not isinstance(enabled, bool):
        raise ProjectValidationError("project_member_invalid")
    member = {
        "agentId": agent_id,
        "role": role,
        "functionTitle": _required_text(
            value.get("functionTitle"),
            "project_function_title_required",
            max_length=PROJECT_FUNCTION_TITLE_MAX_LENGTH,
        ),
        "responsibilities": _required_text(
            value.get("responsibilities"),
            "project_responsibilities_required",
            max_length=PROJECT_RESPONSIBILITIES_MAX_LENGTH,
        ),
    }
    instructions = value.get("instructions")
    if instructions is not None:
        if not isinstance(instructions, str):
            raise ProjectValidationError("project_member_invalid")
        instructions = instructions.strip()
        if len(instructions) > PROJECT_INSTRUCTIONS_MAX_LENGTH:
            raise ProjectValidationError("project_member_text_too_long")
        if instructions:
            member["instructions"] = instructions
    member["enabled"] = enabled
    return member


def agent_has_active_project(project_store: Any, agent_id: str) -> bool:
    return any(
        member.get("agentId") == agent_id
        for project in project_store.list_projects(include_archived=False)
        for member in project.get("members", [])
    )


def _required_text(value: Any, code: str, *, max_length: int | None = None) -> str:
    if not isinstance(value, str) or not value.strip():
        raise ProjectValidationError(code)
    normalized = value.strip()
    if max_length is not None and len(normalized) > max_length:
        raise ProjectValidationError("project_member_text_too_long")
    return normalized
