"""Round manifests: the pure contract a collaboration round is compiled into.

Builds the manifest and its work graph from assignments and a team snapshot.
No IO, so the conductor that plans a round and the registry that adopts a lead
plan compile it the same way.
"""

from __future__ import annotations

from typing import Any

from ..core.ids import new_relay_id
from .styles import LEAD_LED, STYLE_POLICIES


def create_round_manifest(
    *,
    source: str,
    purpose: str,
    address: dict[str, Any],
    assignments: list[dict[str, Any]],
    team_snapshot: dict[str, Any] | None,
    project_snapshot: dict[str, Any] | None = None,
    collaboration_id: str | None = None,
    round_id: str | None = None,
) -> dict[str, Any]:
    strategy = (
        "direct"
        if address.get("kind") == "members" and len(assignments) == 1
        else "room"
        if purpose == "discuss"
        else "review"
        if purpose == "review"
        else "coordinate"
    )
    compiled_assignments = compile_assignment_work_graph(
        assignments,
        purpose=purpose,
        team_snapshot=team_snapshot,
    )
    work_items = [
        {
            "workItemId": assignment["workItemId"],
            "assignmentId": assignment["assignmentId"],
            "ownerAgentId": assignment["workOwnerAgentId"],
            **(
                {"delegationAuthority": assignment["delegationAuthority"]}
                if assignment.get("delegationAuthority")
                else {}
            ),
            "kind": assignment["workKind"],
            "objective": assignment["workObjective"],
            "dependsOnWorkItemIds": assignment["dependsOnWorkItemIds"],
            "required": assignment.get("required", True),
            **{key: assignment[key] for key in ("acceptanceCriteria", "expectedOutputs") if key in assignment},
        }
        for assignment in compiled_assignments
    ]
    completion_kind = "synthesize" if strategy in ("room", "review") else "all_required"
    result_owner = _result_owner_work_item(compiled_assignments)
    style = (team_snapshot or {}).get("collaborationStyle")
    fallback_from = (team_snapshot or {}).get("styleFallbackFrom")
    return {
        "contract": {
            "name": "relay.collaboration.round",
            "version": 2,
        },
        "collaborationId": collaboration_id or new_relay_id("col"),
        "roundId": round_id or new_relay_id("round"),
        "source": source,
        "workScope": {"kind": "thread"},
        "purpose": purpose,
        "strategy": strategy,
        **({"style": style} if style else {}),
        **({"styleFallbackFrom": fallback_from} if fallback_from else {}),
        "address": address,
        **({"teamSnapshot": team_snapshot} if team_snapshot else {}),
        **({"projectSnapshot": project_snapshot} if project_snapshot else {}),
        "assignments": [
            {
                key: assignment[key]
                for key in (
                    "assignmentId",
                    "agentId",
                    "mode",
                    "phase",
                    "role",
                    "brief",
                    "coordinator",
                    "synthesizer",
                )
                if assignment.get(key) is not None
            }
            for assignment in compiled_assignments
        ],
        "completionPolicy": (
            "synthesize" if strategy in ("room", "review") else "assigned_work"
        ),
        "workGraph": {
            "contract": {
                "name": "relay.collaboration.work-graph",
                "version": 1,
            },
            "items": work_items,
            "completion": {
                "kind": completion_kind,
                **({"resultOwnerWorkItemId": result_owner} if result_owner else {}),
            },
            "delegationPolicy": {
                "authority": "conductor",
                "policy": STYLE_POLICIES.get(style or LEAD_LED)
                or ("lead-plan-v1" if source == "lead_plan" else "sequential-role-delegation-v1"),
            },
        },
    }


def compile_assignment_work_graph(
    assignments: list[dict[str, Any]],
    *,
    purpose: str,
    team_snapshot: dict[str, Any] | None,
) -> list[dict[str, Any]]:
    """Attach the conductor-owned delegated-subtask contract to assignments.

    Delivery may remain sequential, but the immutable graph records the actual
    ownership and prerequisites independently of that transport choice.

    Recompute dependencies from the current roster, including when a lead plan
    removes every specialist from an already-compiled round. Reuse the captured
    objectives so compiling the same roster again remains idempotent.
    """
    work_item_ids = [assignment["assignmentId"] for assignment in assignments]
    compiled: list[dict[str, Any]] = []
    for index, assignment in enumerate(assignments):
        work_item_id = assignment["assignmentId"]
        synthesizer = assignment.get("synthesizer") is True
        if synthesizer:
            dependencies = work_item_ids[:index]
        elif purpose in ("discuss", "review"):
            dependencies = []
        else:
            # The current delivery adapter is sequential. Recording that chain
            # makes the graph truthful today while leaving the public contract
            # ready for a later dependency-aware parallel reconciler.
            dependencies = work_item_ids[:index]
        owner_agent_id = _work_owner_agent_id(assignment)
        objective = assignment.get("workObjective") or _work_objective(
            assignment,
            index=index,
            total=len(assignments),
            dependencies=dependencies,
        )
        compiled.append(
            {
                **assignment,
                "brief": objective,
                "workItemId": work_item_id,
                "workOwnerAgentId": owner_agent_id,
                "workKind": _work_kind(assignment),
                "workObjective": objective,
                "dependsOnWorkItemIds": dependencies,
                "delegationAuthority": "conductor",
            }
        )
    return compiled


def _work_owner_agent_id(assignment: dict[str, Any]) -> str:
    agent_id = assignment.get("agentId")
    if isinstance(agent_id, str) and agent_id:
        return agent_id
    executor = assignment.get("executorKind") or assignment.get("agent") or "unknown"
    return f"legacy-executor:{executor}"


def _work_kind(assignment: dict[str, Any]) -> str:
    # Pipeline's last specialist also reports the aggregate result; it still
    # owns its role's work rather than a separate synthesis-only turn.
    if assignment.get("synthesizer") is True and (
        assignment.get("teamSnapshot") or {}
    ).get("collaborationStyle") != "pipeline":
        return "synthesis"
    mode = assignment.get("mode") or "action"
    role = assignment.get("role")
    if mode == "ask":
        return "discussion"
    if mode == "review":
        return "review"
    if assignment.get("coordinator") is True:
        return "coordination"
    if role == "reviewer":
        return "review"
    if role == "tester":
        return "verification"
    if role == "planner":
        return "planning"
    if role == "fixer":
        return "repair"
    return "implementation"


def _work_objective(
    assignment: dict[str, Any],
    *,
    index: int,
    total: int,
    dependencies: list[str],
) -> str:
    brief = assignment.get("brief")
    if isinstance(brief, str) and brief.strip():
        objective = brief.strip()
    else:
        objective = {
            "discussion": "Contribute to the team's discussion.",
            "review": "Review the accumulated team result.",
            "verification": "Verify the accumulated implementation.",
            "planning": "Plan the delegated team work.",
            "repair": "Repair confirmed defects in the accumulated work.",
            "coordination": "Coordinate the delegated team work.",
            "synthesis": "Synthesize the team's contributions into one result.",
            "implementation": "Implement a distinct part of the shared goal.",
        }[_work_kind(assignment)]
    if total <= 1 or assignment.get("coordinator") or assignment.get("synthesizer"):
        return objective
    if not dependencies:
        return (
            f"{objective} Own delegated work item {index + 1} of {total} as an "
            "independently eligible contribution; do not duplicate another item."
        )
    return (
        f"{objective} Own delegated work item {index + 1} of {total}; "
        "use predecessor results and do not duplicate another item."
    )


def _result_owner_work_item(assignments: list[dict[str, Any]]) -> str | None:
    synthesizers = [
        assignment
        for assignment in assignments
        if assignment.get("synthesizer") is True
    ]
    if synthesizers:
        return synthesizers[-1]["workItemId"]
    writable = [
        assignment
        for assignment in assignments
        if (assignment.get("mode") or "action") != "ask"
    ]
    owner = writable[-1] if writable else assignments[-1] if assignments else None
    return owner["workItemId"] if owner else None
