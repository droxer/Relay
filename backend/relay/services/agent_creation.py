"""Validation for creating an agent. Shared by the employee and admin routes."""

from __future__ import annotations

from typing import Any

from ..core.computer_identity import computer_id
from ..core.models import AGENT_ROLES
from ..persistence.agent_placement_store import create_node_placement


class AgentCreationError(ValueError):
    def __init__(self, code: str, message: str, status: int = 400):
        super().__init__(message)
        self.code = code
        self.status = status


def computer_nodes(
    ctx: Any, target_computer_id: str, employee_id: str
) -> list[dict[str, Any]]:
    """All node records for this employee's computer (online or not).

    The ``employeeId`` filter is what keeps one employee from creating an
    agent on a computer that genuinely belongs to someone else — matching on
    computerId alone would not be enough, since a caller could still name
    another employee's computerId directly in the request body.
    """
    return [
        node
        for node in ctx.registry.monitor_nodes()
        if computer_id(node) == target_computer_id
        and node.get("employeeId") == employee_id
    ]


def available_runtimes(nodes: list[dict[str, Any]]) -> set[str]:
    """The set of runtimes currently available on this computer."""
    supported: set[str] = set()
    disabled: set[str] = set()
    for node in nodes:
        supported |= set(node.get("supportedAgents") or [])
        supported |= {
            kind
            for kind, status in (node.get("agents") or {}).items()
            if status == "ready"
        }
        disabled |= set(node.get("disabledAgents") or [])
    return supported - disabled


def create_agent_for_employee(
    ctx: Any, supervisor_employee_id: str, body: dict[str, Any]
) -> dict[str, Any]:
    if "skillPolicy" in body:
        raise AgentCreationError(
            "skill_policy_grants_only",
            "Use skill grant routes to manage skillPolicy.",
            status=422,
        )
    target_computer_id = (body.get("computerId") or "").strip()
    if not target_computer_id:
        raise AgentCreationError("computer_required", "computerId is required.")
    nodes = computer_nodes(ctx, target_computer_id, supervisor_employee_id)
    if not nodes:
        raise AgentCreationError(
            "computer_not_found", "Computer not found.", status=404
        )
    executor_kind = (body.get("executorKind") or "").strip()
    if executor_kind not in available_runtimes(nodes):
        raise AgentCreationError(
            "runtime_unavailable",
            f"This computer does not have the {executor_kind or '(missing)'} runtime.",
        )
    default_role = (body.get("defaultRole") or "").strip()
    if default_role not in AGENT_ROLES:
        raise AgentCreationError(
            "role_invalid",
            f"defaultRole must be one of: {', '.join(AGENT_ROLES)}.",
        )
    agent = ctx.agent_store.create_agent(
        supervisor_employee_id,
        {
            **{
                key: value
                for key, value in body.items()
                if key
                in (
                    "displayName",
                    "profileImageUrl",
                    "instructions",
                    "toolPolicy",
                    "modelPolicy",
                )
            },
            "computerId": target_computer_id,
            "executorKind": executor_kind,
            "defaultRole": default_role,
        },
    )
    _place_on_a_live_node(ctx, agent, nodes)
    return agent


def _place_on_a_live_node(
    ctx: Any, agent: dict[str, Any], nodes: list[dict[str, Any]]
) -> None:
    """Place the agent on a live node that can actually run its runtime, or leave it unplaced.

    A computer can be made up of several node records (re-provisioning swaps
    in a new node id, and the old record doesn't automatically go away), and
    those node records don't have to agree on which runtimes are ready.
    available_runtimes() unions ready runtimes across all of a computer's
    nodes to decide whether creation is allowed, but placement has to land on
    the *specific* node that is actually ready for this executorKind —
    placing it on the wrong node would make the daemon's dispatch admission
    check reject this agent forever.

    Note: there is no "backfill placement once the computer comes online"
    fallback here — sync_node_agents today only serves compatibility agents
    and doesn't look at an explicitly-created agent's computerId. That
    fallback won't exist until Task 4 rewrites sync_node_agents; until then,
    an agent created for an offline computer stays unplaced.
    """
    live = next(
        (
            node
            for node in nodes
            if node.get("online")
            and not node.get("stale")
            and node.get("status") in ("ready", "running")
            and (node.get("agents") or {}).get(agent["executorKind"]) == "ready"
        ),
        None,
    )
    if live:
        create_node_placement(ctx.agent_placement_store, agent, live)
