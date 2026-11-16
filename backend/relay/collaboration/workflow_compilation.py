"""Pure compilation of frozen Project workflow steps and attempt identities.

This is not dispatch admission. Callers must validate live owner, Project,
Computer and Placement state before *each* command. W1 execution guards remain
until the registry and owner-decision adapter implement that boundary.

A work item identifies a step within a workflow run. An assignment identifies
one attempt at that step. Retrying keeps work dependencies stable and allocates
a new assignment, so a previous attempt's approval cannot authorize a retry.
"""
from __future__ import annotations

import json
from copy import deepcopy
from typing import Any
from uuid import NAMESPACE_URL, uuid5

from ..core.team_workflows import workflow_fields

# Copy only routing/Agent data. A legacy roster may contain lead planning,
# synthesis, optional participation or repair authority; none applies here.
_ROUTING_FIELDS = (
    "agentId", "agent", "executorKind", "agentDisplayName", "agentVersion",
    "agentInstructions", "agentModel", "placementId", "daemonNodeId", "role",
)


def _identity(run_id: str, step_id: str, attempt: int | None = None) -> str:
    # Structured encoding avoids collisions when user-assigned ids contain
    # separators. Replay with the same run/step/attempt has the same identity.
    value = json.dumps(["relay.project-workflow.v1", run_id, step_id, attempt])
    return str(uuid5(NAMESPACE_URL, value))


def _run_id(value: Any) -> str:
    if not isinstance(value, str) or not value.strip() or len(value) > 200:
        raise ValueError("workflow_run_id_invalid")
    return value


def compile_workflow(
    team: dict[str, Any], roster: list[dict[str, Any]], *, run_id: str,
) -> list[dict[str, Any]]:
    """Compile saved order verbatim, without a lead plan or extra final turn.

    ``roster`` contains one resolved record per Logical Agent, not one per
    occurrence in the workflow. Missing or ambiguous records fail closed.
    The detached snapshot is suitable for persistence, but this function does
    not persist it or authorize execution.
    """
    run_id = _run_id(run_id)
    fields = workflow_fields(team)
    if not fields:
        raise ValueError("workflow_definition_required")
    members: dict[str, dict[str, Any]] = {}
    for member in roster:
        agent_id = member.get("agentId")
        if not isinstance(agent_id, str) or not agent_id or agent_id in members:
            raise ValueError("workflow_roster_ambiguous")
        members[agent_id] = member
    snapshot = deepcopy({**team, **fields})
    compiled: list[dict[str, Any]] = []
    for step in fields["workflowSteps"]:
        resolved_member = members.get(step["agentId"])
        if resolved_member is None:
            raise ValueError("workflow_roster_assignee_missing")
        compiled.append({
            **deepcopy({key: resolved_member[key] for key in _ROUTING_FIELDS if key in resolved_member}),
            "workflowRunId": run_id,
            "workflowStepId": step["id"],
            "workflowAttempt": 1,
            "assignmentId": _identity(run_id, step["id"], 1),
            "workItemId": _identity(run_id, step["id"]),
            "workOwnerAgentId": step["agentId"],
            "workKind": "workflow_step",
            "workObjective": step["instructions"],
            "brief": step["instructions"],
            "mode": "action",
            "required": True,
            "coordinator": False,
            "synthesizer": False,
            "delegationAuthority": "conductor",
            "awaitApproval": step["requiresApproval"],
            "acceptanceCriteria": list(step["acceptanceCriteria"]),
            "expectedOutputs": list(step["expectedOutputs"]),
            "dependsOnWorkItemIds": [item["workItemId"] for item in compiled],
            "teamSnapshot": deepcopy(snapshot),
        })
    return compiled


def retry_workflow_assignment(assignment: dict[str, Any]) -> dict[str, Any]:
    """Allocate the next attempt without changing the frozen work contract.

    This is identity allocation only. The adapter must first record an owner
    retry decision and verify exit evidence/reconciliation; this helper does
    not release reservations or enqueue commands.
    """
    run_id = _run_id(assignment.get("workflowRunId"))
    step_id = assignment.get("workflowStepId")
    attempt = assignment.get("workflowAttempt")
    if (
        not isinstance(step_id, str) or not step_id
        or not isinstance(attempt, int) or isinstance(attempt, bool) or attempt < 1
        or assignment.get("assignmentId") != _identity(run_id, step_id, attempt)
        or assignment.get("workItemId") != _identity(run_id, step_id)
    ):
        raise ValueError("workflow_attempt_invalid")
    return {
        **deepcopy(assignment),
        "workflowAttempt": attempt + 1,
        "assignmentId": _identity(run_id, step_id, attempt + 1),
    }


def workflow_work_graph(
    assignments: list[dict[str, Any]], *, team_snapshot: dict[str, Any],
) -> list[dict[str, Any]]:
    """Validate the full frozen sequence at the manifest compilation boundary.

    Legacy graph compilation derives work identities and objectives from roles.
    Workflow assignments already carry those contracts, including retry attempt
    identities. Reconstruct from the snapshot to reject mixed runs, reordered
    steps or changed gates rather than silently accepting or rewriting them.
    Routing fields still require live dispatch admission; this is pure validation.
    """
    if not assignments:
        raise ValueError("workflow_assignments_required")
    run_id = _run_id(assignments[0].get("workflowRunId"))
    roster = {item.get("agentId"): item for item in assignments}
    expected = compile_workflow(team_snapshot, list(roster.values()), run_id=run_id)
    if len(expected) != len(assignments):
        raise ValueError("workflow_assignments_invalid")
    for actual, contract in zip(assignments, expected, strict=True):
        # Validate attempt identity, without interpreting it as authorization to
        # retry. Only the owner-decision adapter may grant that authority.
        retry_workflow_assignment(actual)
        for key, value in contract.items():
            if key in ("assignmentId", "workflowAttempt"):
                continue
            if type(actual.get(key)) is not type(value) or actual.get(key) != value:
                raise ValueError("workflow_assignment_contract_mismatch")
    return deepcopy(assignments)
