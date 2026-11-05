"""Resolve explicitly permitted delegates within a thread's Computer and Project."""

from typing import Any

from ..core.agent_delegation import delegation_agent_ids
from ..core.daemon_capabilities import DAEMON_CAPABILITY_DIRECT_DELEGATION, has_capability
from ..projects.runtime import project_member_ids
from .routing import resolve_agent_assignments


def validate_delegation_targets(ctx: Any, agent: dict[str, Any], value: Any) -> list[str]:
    ids = delegation_agent_ids(value)
    for agent_id in ids:
        target = ctx.agent_store.get_agent(agent_id)
        if agent_id == agent["id"] or not target or target.get("deletedAt") or (
            target.get("supervisorUserId") != agent.get("supervisorUserId")
        ):
            raise ValueError("Delegation targets must be other agents you own.")
        if not agent.get("computerId") or target.get("computerId") != agent["computerId"]:
            raise ValueError("Delegation targets must be on the same Computer.")
    return ids


def delegation_candidates(
    ctx: Any, assignment: dict[str, Any], *, project: dict[str, Any] | None = None,
) -> list[dict[str, Any]]:
    agent = ctx.agent_store.get_agent(assignment.get("agentId")) or {}
    nodes = ctx.registry.monitor_nodes()
    node = next((node for node in nodes if node["id"] == assignment["daemonNodeId"]), None)
    if not has_capability(node, DAEMON_CAPABILITY_DIRECT_DELEGATION):
        return []
    candidates = []
    for agent_id in agent.get("delegationAgentIds") or []:
        if project and agent_id not in project_member_ids(project):
            continue
        try:
            validate_delegation_targets(ctx, agent, [agent_id])
            [target] = resolve_agent_assignments(
                [{"agentId": agent_id, "mode": "action", "phase": "execution"}],
                user_id=agent["supervisorUserId"], is_admin=False,
                agent_store=ctx.agent_store, placement_store=ctx.agent_placement_store,
                daemon_nodes=nodes,
                required_node_id=assignment["daemonNodeId"],
            )
        except ValueError:
            continue  # An unavailable delegate must not prevent A's own work.
        candidates.append(target)
    return candidates
