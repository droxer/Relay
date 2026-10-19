"""The legacy roster for a task that names no project, team, or agent."""
from __future__ import annotations

from typing import Any

from ..agents.routing import AgentRoutingError, resolve_agent_assignments
from .dispatch_outcome import TaskDispatchContext


def implicit_group_assignments_for_task(
    ctx: TaskDispatchContext,
    task: dict[str, Any],
) -> list[dict[str, Any]]:
    """Build the legacy unclassified-task roster from ready named agents.

    Historical tasks predate explicit project/team/agent assignments. Keep
    those rows runnable, but only through agents that already exist and can be
    resolved on the task owner's Computers; daemon registration must not
    manufacture compatibility agents.
    """
    user_id = task.get("assigneeUserId") or task.get("ownerUserId")
    if not user_id:
        return []

    selected: list[dict[str, Any]] = []
    daemon_nodes = ctx.registry.monitor_nodes()
    for logical_agent in ctx.agent_store.list_agents(
        supervisor_user_id=user_id
    ):
        if not logical_agent.get("enabled", True):
            continue
        candidate: dict[str, Any] = {
            "agentId": logical_agent["id"],
            "agent": logical_agent["executorKind"],
        }
        if logical_agent.get("defaultRole"):
            candidate["role"] = logical_agent["defaultRole"]
        try:
            resolve_agent_assignments(
                [*selected, candidate],
                user_id=user_id,
                is_admin=True,
                agent_store=ctx.agent_store,
                placement_store=ctx.agent_placement_store,
                daemon_nodes=daemon_nodes,
            )
        except AgentRoutingError:
            continue
        selected.append(candidate)
    return selected
