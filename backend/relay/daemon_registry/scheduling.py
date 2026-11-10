from __future__ import annotations

import os
from typing import Any

from ..core.models import AGENT_NAMES, AGENT_ROLES


def normalize_agent_role_map(value: Any) -> dict[str, str]:
    if not isinstance(value, dict):
        raise ValueError("agent role map must be an object keyed by agent name.")
    invalid_agents = [name for name in value if name not in AGENT_NAMES]
    if invalid_agents:
        raise ValueError(f"Unknown agent name(s): {', '.join(invalid_agents)}.")
    invalid_roles = [role for role in value.values() if role not in AGENT_ROLES]
    if invalid_roles:
        raise ValueError(
            f"Unknown agent role(s): {', '.join(str(role) for role in invalid_roles)}."
        )
    return {agent: value[agent] for agent in AGENT_NAMES if agent in value}


def effective_role_for_assignment(
    node: dict[str, Any], assignment: dict[str, Any]
) -> str | None:
    explicit_role = assignment.get("role")
    if explicit_role in AGENT_ROLES:
        return explicit_role
    agent = assignment.get("executorKind") or assignment.get("agent")
    raw_overrides = node.get("agentRoleOverrides")
    overrides = raw_overrides if isinstance(raw_overrides, dict) else {}
    raw_defaults = node.get("agentRoleDefaults")
    defaults = raw_defaults if isinstance(raw_defaults, dict) else {}
    return overrides.get(agent) or defaults.get(agent)


def normalize_run_capacity(payload: dict[str, Any]) -> int:
    raw_max = payload.get("maxConcurrentRuns")
    return raw_max if isinstance(raw_max, int) and raw_max > 0 else 1


def node_accepts_run(
    node: dict[str, Any],
    *,
    active_runs: list[dict[str, Any]],
    session_id: str | None = None,
) -> bool:
    if node.get("retiredAt"):
        return False
    if session_id and any(run.get("sessionId") == session_id for run in active_runs):
        return False
    return len(active_runs) < normalize_run_capacity(node)


def node_status_for_active_runs(
    node: dict[str, Any], active_runs: list[dict[str, Any]]
) -> str:
    if node.get("status") in ("stopped", "failed", "provisioning"):
        return node["status"]
    return "running" if active_runs else "ready"


def workspace_paths_match(left: str | None, right: str | None) -> bool:
    return bool(
        left
        and right
        and os.path.normcase(os.path.abspath(left))
        == os.path.normcase(os.path.abspath(right))
    )
