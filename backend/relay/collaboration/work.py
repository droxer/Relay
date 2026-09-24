"""Pure work acceptance, planning and repair policy; no daemon or agent I/O."""

from __future__ import annotations

from copy import deepcopy
from typing import Any
from uuid import NAMESPACE_URL, uuid5

from .contracts import text_list

MAX_WORK_ITEMS = 16
MAX_REPAIRS = 2
MAX_CONSULTATIONS = 2

WORK_PROTOCOL = "_relay_work_protocol"
WORK_RESULTS = "_relay_work_results"
WORK_REPAIRS = "_relay_work_repairs"
WORK_REPAIR_NOTE = "_relay_work_repair_note"
WORK_REPAIR_TARGET = "_relay_work_repair_target"
WORK_PLAN_ERROR = "_relay_work_plan_error"
QUESTION_RESUME = "_relay_question_resume"
QUESTION_TARGET = "_relay_question_target"
QUESTION_NOTE = "_relay_question_note"
QUESTION_COUNT = "_relay_question_count"
WORK_STATE_KEYS = frozenset(
    {
        WORK_PROTOCOL,
        WORK_RESULTS,
        WORK_REPAIRS,
        WORK_REPAIR_NOTE,
        WORK_REPAIR_TARGET,
        WORK_PLAN_ERROR,
        QUESTION_RESUME,
        QUESTION_TARGET,
        QUESTION_NOTE,
        QUESTION_COUNT,
    }
)


def validate_work_result(value: Any) -> dict[str, Any] | None:
    if not isinstance(value, dict) or value.get("status") not in (
        "done",
        "continue",
        "blocked",
    ):
        return None
    try:
        evidence = text_list(value.get("evidence", []), "evidence")
        if value["status"] == "done" and not evidence:
            return None
        result = {"status": value["status"], "evidence": evidence}
        note = value.get("note", "")
        if not isinstance(note, str) or len(note) > 2000:
            return None
        result["note"] = note.strip()
        for field in ("findings", "messages"):
            entries = value.get(field, [])
            if not isinstance(entries, list) or len(entries) > 20:
                return None
            cleaned = []
            for entry in entries:
                if not isinstance(entry, dict):
                    return None
                if field == "findings":
                    target, text = entry.get("workItemId"), entry.get("note")
                    if not isinstance(target, str) or not target or len(target) > 200:
                        return None
                    cleaned.append({"workItemId": target, "note": text})
                else:
                    target, text = entry.get("toWorkItemId"), entry.get("text")
                    if entry.get("kind") not in (
                        "question",
                        "answer",
                        "blocker",
                        "handoff",
                        "decision",
                    ):
                        return None
                    if target is not None and (
                        not isinstance(target, str) or not target or len(target) > 200
                    ):
                        return None
                    cleaned.append(
                        {
                            "kind": entry["kind"],
                            "text": text,
                            **({"toWorkItemId": target} if target else {}),
                        }
                    )
                if not isinstance(text, str) or not text.strip() or len(text) > 2000:
                    return None
            result[field] = cleaned
        # Plan semantics are checked against the frozen, authorized roster.
        if "plan" in value:
            if (
                not isinstance(value["plan"], list)
                or len(value["plan"]) > MAX_WORK_ITEMS
            ):
                return None
            for item in value["plan"]:
                if not isinstance(item, dict) or set(item) - {
                    "agentId",
                    "objective",
                    "acceptanceCriteria",
                    "expectedOutputs",
                }:
                    return None
                if (
                    not isinstance(item.get("agentId"), str)
                    or not 1 <= len(item["agentId"]) <= 200
                ):
                    return None
                if (
                    not isinstance(item.get("objective"), str)
                    or not 1 <= len(item["objective"]) <= 4000
                ):
                    return None
                text_list(item.get("acceptanceCriteria"), "acceptanceCriteria")
                text_list(item.get("expectedOutputs"), "expectedOutputs")
            result["plan"] = deepcopy(value["plan"])
        if result["status"] == "done" and result["findings"]:
            return None
        return result
    except (ValueError, TypeError):
        return None


def record_work_result(
    state: dict[str, Any], assignment: dict[str, Any], result: dict[str, Any] | None
) -> dict[str, Any]:
    results = dict(state.get(WORK_RESULTS) or {})
    results[assignment["assignmentId"]] = result or {
        "status": "missing",
        "evidence": [],
    }
    return {**state, WORK_RESULTS: results}


def predecessor_context(
    state: dict[str, Any], dependencies: list[str]
) -> dict[str, Any]:
    """Bound prompt context while retaining every selected predecessor's status.

    The full attributed evidence remains in agent.completed events. These are
    excerpts, never an alternate source of acceptance truth.
    """
    context = {}
    for key in dependencies[: MAX_WORK_ITEMS + 2]:
        result = (state.get(WORK_RESULTS) or {}).get(key)
        if not isinstance(result, dict):
            continue
        evidence = result.get("evidence") or []
        excerpts = [item[:300] for item in evidence[:2]]
        context[key] = {
            "status": result.get("status"),
            "note": (result.get("note") or "")[:300],
            "evidence": excerpts,
            "evidenceTruncated": excerpts != evidence,
        }
    return context


def completion_blockers(
    assignments: list[dict[str, Any]], state: dict[str, Any], *, require_evidence: bool,
    allow_unfinished: bool = False,
) -> list[str]:
    required = {
        item["assignmentId"]: item for item in assignments if item.get("required", True)
    }
    blockers = [state[WORK_PLAN_ERROR]] if state.get(WORK_PLAN_ERROR) else []
    for failure in state.get("_relay_participant_failures") or []:
        if failure.get("assignmentId") in required:
            blockers.append(f"Required contribution {failure['assignmentId']} failed.")
    if require_evidence:
        required_work = {
            item.get("workItemId") or key for key, item in required.items()
        }
        for report in (state.get(WORK_RESULTS) or {}).values():
            for finding in report.get("findings", []):
                if finding["workItemId"] in required_work:
                    blockers.append(
                        f"Unresolved finding on {finding['workItemId']}: {finding['note']}"
                    )
        for assignment_id in required:
            result = (state.get(WORK_RESULTS) or {}).get(assignment_id) or {}
            # A valid unfinished report may request another bounded task round.
            # Findings, missing reports and blocked work still fail closed.
            if (
                allow_unfinished
                and result.get("status") == "continue"
                and not result.get("findings")
            ):
                continue
            if result.get("status") != "done" or not result.get("evidence"):
                blockers.append(
                    f"Work {assignment_id} is not accepted: {result.get('note') or result.get('status') or 'missing evidence'}."
                )
    return blockers


def repair_transition(
    assignments: list[dict[str, Any]],
    index: int,
    state: dict[str, Any],
    *,
    max_repairs: int,
) -> tuple[int, dict[str, Any]] | None:
    if int(state.get(WORK_REPAIRS) or 0) >= max_repairs:
        return None
    current = assignments[index]
    result = (state.get(WORK_RESULTS) or {}).get(current["assignmentId"]) or {}
    if result.get("status") != "continue" or not result.get("findings"):
        return None
    targets = []
    for finding in result["findings"]:
        target = next(
            (
                position
                for position, item in enumerate(assignments[:index])
                if (item.get("workItemId") or item["assignmentId"])
                == finding["workItemId"]
                and item.get("workKind") in ("implementation", "repair")
                and item.get("mode", "action") == "action"
            ),
            None,
        )
        if target is None:
            return None
        targets.append(target)
    start = min(targets)
    # Sequential revalidation is conservative: every downstream result is stale.
    invalidated = {item["assignmentId"] for item in assignments[start:]}
    updated = {
        **state,
        WORK_REPAIRS: int(state.get(WORK_REPAIRS) or 0) + 1,
        WORK_RESULTS: {
            key: value
            for key, value in (state.get(WORK_RESULTS) or {}).items()
            if key not in invalidated
        },
        WORK_REPAIR_TARGET: assignments[start]["assignmentId"],
        WORK_REPAIR_NOTE: "Repair these findings, then the affected contributions will be revalidated:\n"
        + "\n".join(
            f"{item['workItemId']}: {item['note']}" for item in result["findings"]
        ),
    }
    updated.pop("_relay_round_result", None)
    return start, updated


def question_transition(
    assignments: list[dict[str, Any]], index: int, state: dict[str, Any]
) -> tuple[int, dict[str, Any]] | None:
    """One bounded consultation at a time, with an explicit requester to resume."""
    result = (state.get(WORK_RESULTS) or {}).get(
        assignments[index]["assignmentId"]
    ) or {}
    resume = state.get(QUESTION_RESUME)
    if isinstance(resume, int):
        requester = (
            assignments[resume].get("workItemId") or assignments[resume]["assignmentId"]
        )
        if (
            state.get(QUESTION_TARGET) != index
            or result.get("status") != "done"
            or not any(
                message.get("kind") == "answer"
                and message.get("toWorkItemId") == requester
                for message in result.get("messages", [])
            )
        ):
            return None
        return resume, {
            key: value
            for key, value in state.items()
            if key not in (QUESTION_RESUME, QUESTION_TARGET, QUESTION_NOTE)
        }
    if int(state.get(QUESTION_COUNT) or 0) >= MAX_CONSULTATIONS or result.get(
        "status"
    ) not in ("continue", "blocked"):
        return None
    for message in result.get("messages", []):
        if message.get("kind") != "question":
            continue
        target = next(
            (
                position
                for position, item in enumerate(assignments[:index])
                if (item.get("workItemId") or item["assignmentId"])
                == message.get("toWorkItemId")
            ),
            None,
        )
        if target is not None:
            requester = (
                assignments[index].get("workItemId")
                or assignments[index]["assignmentId"]
            )
            return target, {
                **state,
                QUESTION_RESUME: index,
                QUESTION_TARGET: target,
                QUESTION_COUNT: int(state.get(QUESTION_COUNT) or 0) + 1,
                QUESTION_NOTE: f"Answer the question from work item {requester}: {message['text']}\nDo not repeat implementation. Include an answer message addressed to {requester} in work.messages.",
            }
    return None


def compile_proposed_plan(
    assignments: list[dict[str, Any]], plan: Any, round_id: str
) -> list[dict[str, Any]]:
    if (
        not assignments
        or not assignments[0].get("coordinator")
        or not isinstance(plan, list)
        or not 0 <= len(plan) <= MAX_WORK_ITEMS
    ):
        raise ValueError(
            "A coordinator plan must contain at most 16 bounded work items."
        )
    templates = {
        item["agentId"]: item
        for item in assignments
        if not item.get("synthesizer") and not item.get("coordinator")
    }
    required = {key for key, item in templates.items() if item.get("required", True)}
    compiled = [deepcopy(assignments[0])]
    selected = set()
    for index, proposal in enumerate(plan):
        if not isinstance(proposal, dict) or set(proposal) - {
            "agentId",
            "objective",
            "acceptanceCriteria",
            "expectedOutputs",
        }:
            raise ValueError(
                "Plan items accept an owner, objective, acceptance criteria and expected outputs only."
            )
        agent_id = proposal.get("agentId")
        if not isinstance(agent_id, str) or agent_id not in templates:
            raise ValueError(
                "Plan owner must be an authorized specialist in this round."
            )
        objective = proposal.get("objective")
        if (
            not isinstance(objective, str)
            or not objective.strip()
            or len(objective) > 4000
        ):
            raise ValueError(
                "Every planned work item needs an objective of at most 4000 characters."
            )
        criteria = text_list(proposal.get("acceptanceCriteria"), "acceptanceCriteria")
        outputs = text_list(proposal.get("expectedOutputs"), "expectedOutputs")
        if not criteria or not outputs:
            raise ValueError(
                "Every planned item needs acceptance criteria and expected outputs."
            )
        template = templates[agent_id]
        item = {
            key: value
            for key, value in template.items()
            if key
            not in {
                "workItemId",
                "workOwnerAgentId",
                "workKind",
                "workObjective",
                "dependsOnWorkItemIds",
                "delegationAuthority",
            }
        }
        item.update(
            assignmentId=str(uuid5(NAMESPACE_URL, f"{round_id}:plan:{index}")),
            brief=objective.strip(),
            acceptanceCriteria=list(
                dict.fromkeys([*template.get("acceptanceCriteria", []), *criteria])
            ),
            expectedOutputs=outputs,
            required=True,
        )
        compiled.append(item)
        selected.add(agent_id)
    if required - selected:
        raise ValueError("The plan omitted a required team contribution.")
    # Verification/review may not precede writes, even if proposed out of order.
    stage = {"planner": 0, "implementer": 1, "fixer": 1, "tester": 2, "reviewer": 3}
    compiled[1:] = sorted(compiled[1:], key=lambda item: stage.get(item.get("role"), 1))
    final = next(
        (deepcopy(item) for item in reversed(assignments) if item.get("synthesizer")),
        None,
    )
    if not final:
        raise ValueError("The plan needs an explicit result owner.")
    compiled.append(final)
    return compiled
