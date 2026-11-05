"""Pure, bounded compilation of an agent-requested A → B → A turn sequence."""

from copy import deepcopy
from typing import Any
from uuid import NAMESPACE_URL, uuid5

from .contracts import text_list

MAX_DELEGATIONS = 2
DELEGATION_REFUSAL = "_relay_delegation_refusal"


def delegation_request(value: Any) -> dict[str, Any]:
    if not isinstance(value, dict) or set(value) - {
        "agentId", "objective", "context", "acceptanceCriteria", "expectedOutputs",
    }:
        raise ValueError("A delegation accepts a target, objective, context and deliverables only.")
    result: dict[str, Any] = {}
    for key, limit in (("agentId", 200), ("objective", 4000), ("context", 4000)):
        text = value.get(key, "")
        if not isinstance(text, str) or len(text) > limit or (key != "context" and not text.strip()):
            raise ValueError(f"Invalid delegation {key}.")
        if key != "context" or text.strip():
            result[key] = text.strip()
    for key in ("acceptanceCriteria", "expectedOutputs"):
        result[key] = text_list(value.get(key), key)
        if not result[key]:
            raise ValueError("Delegation needs acceptance criteria and expected outputs.")
    return result


def compile_delegation(
    assignments: list[dict[str, Any]], index: int, proposal: Any,
    candidates: list[dict[str, Any]],
) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    request = delegation_request(proposal)
    requester = assignments[index]
    count = sum(bool(item.get("delegatedByAgentId")) for item in assignments)
    if requester.get("delegatedByAgentId") or count >= MAX_DELEGATIONS:
        raise ValueError("Nested delegation is unavailable; at most two delegations are allowed per round.")
    if requester.get("mode", "action") != "action" or requester.get("teamSnapshot"):
        raise ValueError("Direct delegation requires an individual action round.")
    target = next((item for item in candidates if item["agentId"] == request["agentId"]), None)
    if not target or target["agentId"] == requester["agentId"] or (
        target.get("daemonNodeId") != requester.get("daemonNodeId")
    ):
        raise ValueError("This agent is not an allowed, available delegation target.")
    identity = str(uuid5(NAMESPACE_URL, f"{requester['assignmentId']}:delegation"))
    child_id, resume_id = f"{identity}:work", f"{identity}:resume"
    brief = request["objective"] + (
        "\n\nContext: " + request["context"] if request.get("context") else ""
    ) + "\n\nReturn your changes, evidence and blockers to the requesting agent. Do not delegate further."
    child = {
        **deepcopy(target), "assignmentId": child_id, "brief": brief,
        "workObjective": brief, "required": False,
        "acceptanceCriteria": request["acceptanceCriteria"], "expectedOutputs": request["expectedOutputs"],
        "delegatedByAgentId": requester["agentId"], "delegationId": identity,
    }
    resume = {
        **deepcopy(requester), "assignmentId": resume_id,
        "brief": "Resume the original request. Inspect the delegate's result, handle any failure or blocker, "
        "and verify the deliverables before reporting your own outcome.\n\n" + (requester.get("brief") or ""),
        "delegationReturnId": identity,
    }
    resume.pop("workObjective", None)
    # A yielded rather than completing its task; only its resumed turn can certify it.
    yielded = {**deepcopy(requester), "required": False}
    planned = [*deepcopy(assignments[:index]), yielded, child, resume, *deepcopy(assignments[index + 1:])]
    receipt = {
        "id": identity, "requestedByAgentId": requester["agentId"], "targetAgentId": target["agentId"],
        "requesterAssignmentId": requester["assignmentId"], "childAssignmentId": child_id,
        "resumeAssignmentId": resume_id, **{key: value for key, value in request.items() if key != "agentId"},
    }
    return planned, receipt
