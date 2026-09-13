from __future__ import annotations

from collections.abc import Mapping
from typing import Any

from ..core.computer_identity import computer_id
from ..daemon_registry.scheduling import node_accepts_run
from ..persistence.agent_placement_store import placement_status
from ..sessions.controller import SessionController


class AgentRoutingError(ValueError):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code


def dispatch_reason_code(code: str) -> str:
    return {
        "agent_configuration_pending": "configuration_pending",
        "executor_not_ready": "agent_offline",
        "node_offline": "agent_offline",
    }.get(code, code)


def dispatch_failure_code(error: Exception) -> str:
    if isinstance(error, AgentRoutingError):
        return dispatch_reason_code(error.code)
    if isinstance(error, PermissionError):
        return "agent_forbidden"
    message = str(error)
    for code in (
        "agent_policy_unsupported",
        "capacity_exhausted",
        "task_wip_limit",
        "workspace_unavailable",
        "configuration_pending",
        "agent_offline",
        "agent_forbidden",
    ):
        if code in message:
            return code
    return "dispatch_failed"


def placement_node(
    placement: Mapping[str, Any], nodes: Mapping[str, dict[str, Any]]
) -> dict[str, Any] | None:
    """Find the live node currently hosting this placement's Computer.

    A placement records a `computerId` (stable), not a node id (which
    changes). An older placement without a `computerId` falls back to a direct
    node-id lookup, behaving exactly as it did before the identity model
    landed.
    """
    identity = placement.get("computerId")
    if not identity:
        return nodes.get(placement.get("daemonNodeId"))
    candidates = [node for node in nodes.values() if computer_id(node) == identity]
    if not candidates:
        return None
    return min(
        candidates,
        key=lambda node: (
            0
            if node.get("online")
            and not node.get("stale")
            and node.get("status") in ("ready", "busy", "running")
            else 1,
            node["id"],
        ),
    )


def resolve_session_daemon_node_id(
    session: dict[str, Any] | None,
    daemon_nodes: list[dict[str, Any]],
) -> str | None:
    """Resolve the Computer a thread is pinned to into its current runtime node.

    Returns None while that Computer is offline — the thread is never moved to
    another machine. Its artifacts live in that machine's directories, so
    running elsewhere hands the agent an empty workspace: it looks like work,
    but the context is gone.

    Identity priority:
    1. `session["computerId"]` — the stable identity materialized by replaying
       the `session.created` / `session.runtime_affinity` events.
    2. No `computerId` but a `managedNodeId` (a session created before the
       affinity events existed, not yet backfilled) — derive
       `managed:{managedNodeId}`, exactly the compatibility derivation
       `_apply_session_runtime_affinity` performs at the replay layer, and for
       the same reason: an older session must not lose the ability to follow
       its managed node through an id change just because the identity model
       moved on.
    3. Neither — fall back to the literal `session["daemonNodeId"]`. This is
       the only way a pending thread from `POST /tasks` (which has not chosen
       a node yet) resolves to one, so it has to stay.
    """
    if not session:
        return None
    identity = session.get("computerId")
    if not identity:
        managed_node_id = session.get("managedNodeId")
        if isinstance(managed_node_id, str) and managed_node_id:
            identity = f"managed:{managed_node_id}"
    if not identity:
        recorded = session.get("daemonNodeId")
        return recorded if isinstance(recorded, str) and recorded else None
    candidates = [
        node
        for node in daemon_nodes
        if computer_id(node) == identity
        and not node.get("retiredAt")
        and node.get("online")
        and not node.get("stale")
        and node.get("status") in ("ready", "busy", "running")
    ]
    if not candidates:
        return None
    return min(candidates, key=lambda node: node["id"])["id"]


def resolve_agent_assignments(
    assignments: list[dict[str, Any]],
    *,
    employee_id: str,
    is_admin: bool,
    agent_store: Any,
    placement_store: Any,
    daemon_nodes: list[dict[str, Any]],
    session: dict[str, Any] | None = None,
    required_node_id: str | None = None,
    daemon_store: Any | None = None,
    session_store: Any | None = None,
) -> list[dict[str, Any]]:
    nodes = {node["id"]: node for node in daemon_nodes}
    resolved: list[dict[str, Any]] = []
    selected_node_ids = _session_affinity(session, placement_store, nodes, daemon_store)
    if required_node_id:
        required_node = nodes.get(required_node_id)
        if not required_node:
            raise AgentRoutingError(
                "node_offline", "Selected thread computer is not available."
            )
        if selected_node_ids and required_node_id not in selected_node_ids:
            raise AgentRoutingError(
                "workspace_unavailable",
                "Selected computer does not match the thread runtime.",
            )
        selected_node_ids.add(required_node_id)
    for assignment in assignments:
        agent_id = assignment.get("agentId")
        if not isinstance(agent_id, str) or not agent_id:
            raise AgentRoutingError(
                "agent_not_found", "agentId is required for agent-first dispatch."
            )
        agent = agent_store.get_agent(agent_id)
        if not agent or agent.get("deletedAt"):
            raise AgentRoutingError(
                "agent_not_found", f"Agent {agent_id} was not found."
            )
        if not is_admin and agent.get("supervisorEmployeeId") != employee_id:
            raise AgentRoutingError(
                "agent_forbidden",
                f"Agent {agent_id} is not available to this employee.",
            )
        if not agent.get("enabled", True):
            raise AgentRoutingError(
                "agent_disabled", f"Agent {agent['displayName']} is disabled."
            )
        policy_fields = [
            field
            for field in ("toolPolicy", "modelPolicy")
            if agent.get(field)
        ]
        if policy_fields:
            raise AgentRoutingError(
                "agent_policy_unsupported",
                f"Agent {agent['displayName']} has policy metadata that this runtime cannot enforce.",
            )
        requested_kind = assignment.get("executorKind")
        if requested_kind and requested_kind != agent["executorKind"]:
            raise AgentRoutingError(
                "executor_mismatch",
                f"Agent {agent['displayName']} uses {agent['executorKind']}, not {requested_kind}.",
            )
        placements = placement_store.list_placements(agent_id=agent["id"])
        candidates = []
        rejection_reasons: set[str] = set()
        for placement in placements:
            node = placement_node(placement, nodes)
            view = placement_status(placement, agent, node)
            if view["status"] not in ("ready", "busy"):
                rejection_reasons.update(
                    condition["reason"] for condition in view.get("conditions", [])
                )
                continue
            if not node_accepts_run(
                node,
                active_runs=node.get("activeRuns") or [],
            ):
                rejection_reasons.add("capacity_exhausted")
                continue
            if selected_node_ids and node["id"] not in selected_node_ids:
                rejection_reasons.add("workspace_unavailable")
                continue
            candidates.append((placement, node))
        if not candidates and session is None and session_store is not None:
            attached = _attach_never_run_agent_to_managed_capacity(
                agent,
                placements,
                placement_store=placement_store,
                session_store=session_store,
                nodes=nodes,
                selected_node_ids=selected_node_ids,
            )
            if attached:
                candidates.append(attached)
        if not candidates:
            code = _best_rejection_code(rejection_reasons)
            raise AgentRoutingError(code, _rejection_message(agent, code))
        placement, node = min(
            candidates,
            key=lambda item: (
                0 if item[1].get("status") != "running" else 1,
                int(item[0].get("priority") or 100),
                -(
                    int(item[1].get("maxConcurrentRuns") or 1)
                    - len(item[1].get("activeRuns") or [])
                ),
                item[0]["id"],
            ),
        )
        selected_node_ids.add(node["id"])
        resolved.append(
            {
                **assignment,
                "agentId": agent_id,
                "agent": agent["executorKind"],
                "agentDisplayName": agent["displayName"],
                "executorKind": agent["executorKind"],
                "agentVersion": agent["version"],
                **(
                    {"agentInstructions": agent["instructions"]}
                    if agent.get("instructions")
                    else {}
                ),
                "placementId": placement["id"],
                "daemonNodeId": node["id"],
            }
        )
    return resolved


def _rejection_message(agent: Mapping[str, Any], code: str) -> str:
    """Say what actually went wrong, not just that nothing was eligible.

    A round is pinned to one computer, so a team whose members live on
    different machines fails here. Reporting that as "no eligible runtime
    placement" sends the reader off to inspect an agent that is perfectly
    healthy.
    """
    if code == "workspace_unavailable":
        return (
            f"Agent {agent['displayName']} runs on a different computer than "
            "the rest of this round; every participant must share one computer."
        )
    return (
        f"Agent {agent['displayName']} has no eligible runtime placement ({code})."
    )


def _attach_never_run_agent_to_managed_capacity(
    agent: dict[str, Any],
    placements: list[dict[str, Any]],
    *,
    placement_store: Any,
    session_store: Any,
    nodes: Mapping[str, dict[str, Any]],
    selected_node_ids: set[str],
) -> tuple[dict[str, Any], dict[str, Any]] | None:
    """Attach a phantom, never-run agent to its first real Computer."""
    if not placements or any(
        placement.get("computerId") or placement.get("daemonNodeId") in nodes
        for placement in placements
    ):
        return None
    placement_ids = {placement["id"] for placement in placements}
    if session_store.has_agent_run(agent["id"], placement_ids):
        return None
    candidate = min(
        (
            node
            for node in nodes.values()
            if node.get("managedNodeId")
            and node.get("employeeId") == agent.get("supervisorEmployeeId")
            and node.get("online")
            and not node.get("stale")
            and node.get("status") in ("ready", "running")
            and placement_status(
                {"desiredState": "active", "executorKind": agent["executorKind"]},
                agent,
                node,
            )["status"]
            in ("ready", "busy")
            and agent["executorKind"] not in set(node.get("disabledAgents") or [])
            and (not selected_node_ids or node["id"] in selected_node_ids)
            and node_accepts_run(node, active_runs=node.get("activeRuns") or [])
        ),
        key=lambda node: node["id"],
        default=None,
    )
    if candidate is None:
        return None
    placement = placement_store.attach_first_managed_placement(
        agent, candidate, expected_placement_ids=placement_ids
    )
    return (placement, candidate) if placement else None


def resolve_legacy_session_computer_id(
    session: Mapping[str, Any],
    placement_store: Any,
    nodes: Mapping[str, dict[str, Any]],
    daemon_store: Any | None,
) -> str | None:
    """Recover a pre-Task-5 session's Computer identity, read-only.

    `resolve_session_daemon_node_id` only reads what's already on the
    session (`computerId`, then `managedNodeId`, then a literal
    `daemonNodeId`). Sessions created before Task 5 wired up
    `session.runtime_affinity` may carry none of the first two — their only
    trace of identity is the daemon node they last ran on. Explicit dispatch
    paths call `persist_legacy_session_computer_id` to append the recovered
    identity once. The workspace-browse route calls this resolver directly
    and keeps the recovery in memory, so a read-only request never invokes
    the write-once guard or turns an identity conflict into a 500.

    Priority mirrors `_backfill_runtime_affinity`: the node currently
    registered under the session's last known `daemonNodeId` may itself
    carry a `managedNodeId`; failing that, the daemon registry's history of
    that runtime id is consulted; failing that, a placement rebind (a
    managed Computer redeployed under a new node id after the session's
    last run) is followed only when the destination is itself managed.
    """
    if session.get("computerId"):
        return session["computerId"]
    if session.get("managedNodeId"):
        return f"managed:{session['managedNodeId']}"
    session_node_id = session.get("daemonNodeId")
    managed_node_id = None
    if isinstance(session_node_id, str) and session_node_id:
        managed_node_id = (nodes.get(session_node_id) or {}).get("managedNodeId")
        if not managed_node_id:
            historical_managed_node_id = getattr(
                daemon_store, "historical_managed_node_id", None
            )
            if historical_managed_node_id:
                managed_node_id = historical_managed_node_id(session_node_id)
    if managed_node_id:
        return f"managed:{managed_node_id}"
    prior_run = next(
        (
            run
            for run in reversed(session.get("agentRuns") or [])
            if run.get("daemonNodeId")
        ),
        None,
    )
    node_id = session_node_id or (prior_run or {}).get("daemonNodeId")
    if not prior_run or not prior_run.get("placementId"):
        return None
    placement = placement_store.get_placement(prior_run["placementId"])
    if (placement or {}).get("computerId"):
        return placement["computerId"]
    rebound_node_id = (placement or {}).get("daemonNodeId")
    if not isinstance(rebound_node_id, str) or rebound_node_id == node_id:
        return None
    rebound_node = nodes.get(rebound_node_id)
    if not rebound_node or not rebound_node.get("managedNodeId"):
        return None
    previous_node = nodes.get(node_id) if isinstance(node_id, str) else None
    if previous_node and previous_node.get("managedNodeId") != rebound_node.get(
        "managedNodeId"
    ):
        return None
    return f"managed:{rebound_node['managedNodeId']}"


def persist_legacy_session_computer_id(
    session: dict[str, Any] | None,
    *,
    session_store: Any,
    placement_store: Any,
    nodes: Mapping[str, dict[str, Any]],
    daemon_store: Any | None,
) -> dict[str, Any] | None:
    """Persist a legacy Computer identity from an explicit write path."""
    if not session or session.get("computerId"):
        return session
    identity = resolve_legacy_session_computer_id(
        session, placement_store, nodes, daemon_store
    )
    if not identity:
        return session
    return SessionController(session_store).record_runtime_affinity(
        session["id"], identity
    )


def _session_affinity(
    session: dict[str, Any] | None,
    placement_store: Any,
    nodes: dict[str, dict[str, Any]],
    daemon_store: Any | None = None,
) -> set[str]:
    if not session:
        return set()
    identity = resolve_legacy_session_computer_id(
        session, placement_store, nodes, daemon_store
    )
    if identity and identity != session.get("computerId"):
        session = {**session, "computerId": identity}
    prior_run = next(
        (
            run
            for run in reversed(session.get("agentRuns") or [])
            if run.get("daemonNodeId")
        ),
        None,
    )
    session_node_id = resolve_session_daemon_node_id(session, list(nodes.values()))
    if not prior_run:
        if isinstance(session_node_id, str) and session_node_id:
            return {session_node_id}
        if session.get("computerId"):
            # The thread is pinned to a Computer (directly or recovered by
            # resolve_legacy_session_computer_id above) but that Computer has
            # no reachable node right now. An empty constraint set here would
            # let dispatch silently pick a different machine — the thread's
            # workspace lives on the pinned one, so refuse explicitly instead
            # of quietly running somewhere the work was never done.
            raise AgentRoutingError(
                "node_offline",
                "This thread's computer is not currently online.",
            )
        # Legacy sessions acquire runtime affinity after their first agent run.
        return set()
    node_id = session_node_id or prior_run["daemonNodeId"]
    return {node_id}


def _best_rejection_code(reasons: set[str]) -> str:
    for reason in (
        "agent_configuration_pending",
        "workspace_unavailable",
        "executor_not_ready",
        "capacity_exhausted",
        "node_offline",
    ):
        if reason in reasons:
            return reason
    return "agent_offline"
