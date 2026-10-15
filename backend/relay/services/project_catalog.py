from __future__ import annotations

from typing import Any

from ..core.computer_identity import computer_id
from ..core.models import AGENT_ROLES
from ..persistence.project_store import ProjectValidationError
from .agent_location import agent_placed_on_computer
from .project_setup import ProjectSetupError, resolved_setup

PROJECT_NAME_MAX_LENGTH = 120
PROJECT_MEMBER_MAX_COUNT = 32
PROJECT_RESPONSIBILITIES_MAX_LENGTH = 4_000
PROJECT_INSTRUCTIONS_MAX_LENGTH = 8_000
PROJECT_DESCRIPTION_MAX_LENGTH = 4_000
PROJECT_GOAL_MAX_LENGTH = 280
PROJECT_CONTEXT_MAX_LENGTH = 8_000


def create_project_payload(
    owner_user_id: str,
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
    if node.get("userId") != owner_user_id:
        raise ProjectValidationError("project_computer_forbidden")
    if not node.get("workspacePath"):
        raise ProjectValidationError("project_workspace_unavailable")
    if "project-workspaces" not in (node.get("capabilities") or []):
        raise ProjectValidationError("project_workspace_unsupported")
    target_computer_id = computer_id(node)
    members, lead_agent_id = validate_project_roster(
        owner_user_id,
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
        "description": project_description(payload.get("description")),
        "goal": project_goal(payload.get("goal")),
        "context": project_context(payload.get("context")),
        "computerId": target_computer_id,
        "leadAgentId": lead_agent_id,
        "members": members,
        "enabled": enabled,
    }


def project_description(value: Any) -> str:
    """A project's brief: optional free text, stored trimmed; absent is empty."""
    if value is None:
        return ""
    if not isinstance(value, str):
        raise ProjectValidationError("project_description_invalid")
    normalized = value.strip()
    if len(normalized) > PROJECT_DESCRIPTION_MAX_LENGTH:
        raise ProjectValidationError("project_description_too_long")
    return normalized


def project_goal(value: Any) -> str:
    """The outcome a project commits to, in one line; absent is empty."""
    return _optional_text(
        value,
        invalid="project_goal_invalid",
        too_long="project_goal_too_long",
        max_length=PROJECT_GOAL_MAX_LENGTH,
    )


def project_context(value: Any) -> str:
    """The standing brief every project run reads: conventions, constraints,
    definition of done. Markdown, optional; absent is empty."""
    return _optional_text(
        value,
        invalid="project_context_invalid",
        too_long="project_context_too_long",
        max_length=PROJECT_CONTEXT_MAX_LENGTH,
    )


def _optional_text(value: Any, *, invalid: str, too_long: str, max_length: int) -> str:
    if value is None:
        return ""
    if not isinstance(value, str):
        raise ProjectValidationError(invalid)
    normalized = value.strip()
    if len(normalized) > max_length:
        raise ProjectValidationError(too_long)
    return normalized


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
    owner_user_id: str,
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
    allowed = {
        "name",
        "description",
        "goal",
        "context",
        "leadAgentId",
        "members",
        "enabled",
        "setupResolution",
        "resolveContextSuggestions",
        "expectedVersion",
    }
    if set(payload) - allowed:
        raise ProjectValidationError("project_patch_unsupported")
    patch = {
        key: value
        for key, value in payload.items()
        if key not in ("expectedVersion", "setupResolution", "resolveContextSuggestions")
    }
    if "resolveContextSuggestions" in payload:
        # Adopting a suggestion is this PATCH carrying the edited context;
        # adopted and dismissed suggestions both leave the pending list.
        resolved = payload["resolveContextSuggestions"]
        if not isinstance(resolved, list) or not all(isinstance(item, str) for item in resolved):
            raise ProjectValidationError("project_context_suggestions_invalid")
        patch["contextSuggestions"] = [
            item
            for item in current.get("contextSuggestions") or []
            if item.get("id") not in set(resolved)
        ]
    if "setupResolution" in payload:
        # Applying a proposal is this same PATCH carrying the accepted roster
        # and brief, so the setup closes in the same revision that applies it.
        try:
            patch["setup"] = resolved_setup(
                current.get("setup"), payload["setupResolution"]
            )
        except ProjectSetupError as error:
            raise ProjectValidationError(error.code) from error
    if "name" in patch:
        patch["name"] = _required_text(
            patch["name"],
            "project_name_required",
            max_length=PROJECT_NAME_MAX_LENGTH,
        )
    if "description" in patch:
        patch["description"] = project_description(patch["description"])
    if "goal" in patch:
        patch["goal"] = project_goal(patch["goal"])
    if "context" in patch:
        patch["context"] = project_context(patch["context"])
        # Runs pin the revision they read, so a changed brief is a new one.
        if patch["context"] != (current.get("context") or ""):
            patch["contextRevision"] = int(current.get("contextRevision") or 0) + 1
    if "members" in patch or "leadAgentId" in patch:
        members, lead_agent_id = validate_project_roster(
            owner_user_id,
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
            previous_project=current,
        )
        if "members" in patch:
            patch["members"] = members
        # Clearing the last member also clears its lead, even when the caller
        # only supplies members. Keep the roster and lead as one valid update.
        patch["leadAgentId"] = lead_agent_id
    return patch, expected_version


def validate_project_roster(
    owner_user_id: str,
    raw_members: Any,
    lead_agent_id: Any,
    *,
    target_computer_id: str,
    target_node_id: str | None,
    agent_store: Any,
    placement_store: Any,
    previous_project: dict[str, Any] | None = None,
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
    previous_members = {
        member["agentId"]: member
        for member in (previous_project or {}).get("members", [])
    }
    for member in members:
        agent = agent_store.get_agent(member["agentId"])
        if not agent or agent.get("deletedAt"):
            raise ProjectValidationError("project_member_not_found")
        if agent.get("supervisorUserId") != owner_user_id:
            raise ProjectValidationError("project_member_wrong_owner")
        previous = previous_members.get(member["agentId"])
        newly_enabled = member["enabled"] and previous and not previous.get("enabled", True)
        newly_lead = (
            member["agentId"] == lead_agent_id
            and lead_agent_id != (previous_project or {}).get("leadAgentId")
        )
        # Existing members may lose readiness independently of this project.
        # Permit metadata edits, disabling, and incremental removal without
        # requiring every other member to be repaired first. Admission still
        # checks runtime readiness; additions and activation check it here too.
        if previous is not None and not newly_enabled and not newly_lead:
            continue
        if not agent.get("enabled", True):
            raise ProjectValidationError("project_member_disabled")
        if not agent_placed_on_computer(
            agent["id"],
            target_computer_id,
            node_ids={target_node_id} if target_node_id else set(),
            placement_store=placement_store,
        ):
            raise ProjectValidationError("project_member_computer_mismatch")
    return members, lead_agent_id


def _normalize_member(value: Any) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise ProjectValidationError("project_member_invalid")
    allowed = {
        "agentId",
        "role",
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
