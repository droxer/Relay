"""Strict persisted contract for Project-bound sequential Team workflows."""
from __future__ import annotations

import re
from typing import Any

WORKFLOW_FIELDS = frozenset({"projectId", "workflowSteps"})
STEP_FIELDS = frozenset({
    "id", "name", "agentId", "instructions", "expectedOutputs",
    "acceptanceCriteria", "kind", "requiresApproval",
})


def is_workflow_team(team: dict[str, Any]) -> bool:
    # Presence, not truthiness: a damaged contract must never run as a legacy Team.
    return bool(WORKFLOW_FIELDS & team.keys())


def workflow_fields(
    payload: dict[str, Any], *, current: dict[str, Any] | None = None,
) -> dict[str, Any]:
    merged = {**(current or {}), **payload}
    if not is_workflow_team(merged):
        return {}
    project = _text(merged.get("projectId"), "projectId", 128)
    if current and is_workflow_team(current) and project != current.get("projectId"):
        raise ValueError("team_workflow_project_immutable")
    if merged.get("collaborationStyle") is not None or merged.get("humanApproval") not in (None, False):
        raise ValueError("team_workflow_legacy_policy_conflict")
    steps = merged.get("workflowSteps")
    if not isinstance(steps, list) or not 1 <= len(steps) <= 64:
        raise ValueError("workflowSteps must contain 1 to 64 steps.")
    normalized = [_step(step, merged.get("memberAgentIds") or []) for step in steps]
    if len({step["id"] for step in normalized}) != len(normalized):
        raise ValueError("team_workflow_duplicate_step_id")
    return {"projectId": project, "workflowSteps": normalized}


def _step(value: Any, members: list[str]) -> dict[str, Any]:
    if not isinstance(value, dict) or set(value) - STEP_FIELDS:
        raise ValueError("Invalid workflow step fields.")
    step_id = _text(value.get("id"), "id", 64)
    if not re.fullmatch(r"[A-Za-z0-9_-]+", step_id):
        raise ValueError("Invalid workflow step id.")
    agent_id = _text(value.get("agentId"), "agentId", 128)
    if agent_id not in members:
        raise ValueError("team_workflow_assignee_not_member")
    # Read legacy classifications without adding types to new steps. Keep the
    # field when supplied so frozen workflow snapshots remain comparable.
    if "kind" in value and value["kind"] not in ("work", "deployment"):
        raise ValueError("Workflow kind must be work or deployment.")
    approval = value.get("requiresApproval", False)
    if not isinstance(approval, bool):
        raise ValueError("requiresApproval must be a boolean.")
    return {
        "id": step_id, "name": _text(value.get("name"), "name", 200),
        "agentId": agent_id, "instructions": _text(value.get("instructions"), "instructions", 8000),
        "expectedOutputs": _texts(value.get("expectedOutputs"), "expectedOutputs"),
        "acceptanceCriteria": _texts(value.get("acceptanceCriteria"), "acceptanceCriteria"),
        **({"kind": value["kind"]} if "kind" in value else {}),
        "requiresApproval": approval,
    }


def _text(value: Any, field: str, limit: int) -> str:
    if not isinstance(value, str) or not value.strip() or len(value.strip()) > limit:
        raise ValueError(f"{field} must be nonempty text of at most {limit} characters.")
    return value.strip()


def _texts(value: Any, field: str) -> list[str]:
    if not isinstance(value, list) or not 1 <= len(value) <= 32:
        raise ValueError(f"{field} must contain 1 to 32 items.")
    return [_text(item, field, 2000) for item in value]
