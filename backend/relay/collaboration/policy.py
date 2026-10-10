from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Literal

from .models import COLLABORATION_MANIFEST_STATE_KEY
from .work import (
    MAX_REPAIRS,
    QUESTION_NOTE,
    QUESTION_RESUME,
    QUESTION_TARGET,
    RUNTIME_REPAIRS,
    WORK_PLAN_ERROR,
    WORK_REPAIR_NOTE,
    WORK_REPAIR_TARGET,
    WORK_RESULTS,
    question_transition,
    repair_transition,
    repairs_used,
)

REPAIR_COUNT_STATE_KEY = RUNTIME_REPAIRS
REPAIR_RESUME_INDEX_STATE_KEY = "_relay_repair_resume_index"
REPAIR_NOTE_STATE_KEY = "_relay_repair_note"
ROUND_RESULT_STATE_KEY = "_relay_round_result"
PARTICIPANT_FAILURES_STATE_KEY = "_relay_participant_failures"
ROUND_RESULT_STATUSES = frozenset({"done", "continue", "blocked"})
ROUND_RESULT_NOTE_MAX_CHARS = 2000


# Styles whose next member can still inspect the workspace when a member
# finished without a report; the completion gate still rejects the gap.
INSPECTING_STYLES = frozenset({"build_review", "pipeline", "lead_led"})
MISSING_ANSWER_ERROR = "The requested teammate answer was not provided."
MISSING_PLAN_ERROR = "The coordinator did not provide a bounded work plan."


@dataclass(frozen=True)
class WorkTransition:
    """Where an evidence-gated round goes after a successful turn.

    ``next_index`` None ends the round. ``plan`` is a coordinator plan the
    caller must compile into the round before dispatching ``next_index``.
    """

    next_index: int | None
    state: dict[str, Any]
    plan: list[Any] | None = None


@dataclass(frozen=True)
class FailureDecision:
    kind: Literal["repair", "continue", "fail"]
    next_index: int | None
    state: dict[str, Any]


def decide_failure(
    run_request: dict[str, Any],
    next_state: dict[str, Any],
    *,
    outcome: str,
    agent_label: str,
    mode: str,
    max_repairs: int,
) -> FailureDecision:
    """Choose the next collaboration action without performing delivery I/O."""
    assignments = run_request["assignments"]
    index = run_request.get("currentIndex", 0)
    state = dict(next_state)
    repairs = int(state.get(REPAIR_COUNT_STATE_KEY) or 0)
    can_repair = (
        bool(run_request.get("taskId"))
        and index > 0
        and len(assignments) >= 2
        and repairs < max_repairs
        and repairs_used(state) < MAX_REPAIRS
        and assignments[0].get("coordinator") is True
        and (assignments[0].get("mode") or "action") == "action"
    )
    if can_repair:
        state[REPAIR_COUNT_STATE_KEY] = repairs + 1
        # The coordinator can modify the shared workspace. No earlier member
        # report can certify those new contents; rerun the full member sequence.
        state[REPAIR_RESUME_INDEX_STATE_KEY] = 1
        state[WORK_RESULTS] = {}
        for key in (
            ROUND_RESULT_STATE_KEY,
            PARTICIPANT_FAILURES_STATE_KEY,
            QUESTION_RESUME,
            QUESTION_TARGET,
            QUESTION_NOTE,
        ):
            state.pop(key, None)
        state[WORK_REPAIR_TARGET] = assignments[0]["assignmentId"]
        state[WORK_REPAIR_NOTE] = (
            "The coordinator repaired a runtime failure and may have changed "
            "the workspace. Revalidate your contribution against its current contents."
        )
        state[REPAIR_NOTE_STATE_KEY] = (
            f"{outcome} You are the coordinator on this task: fix the cause so "
            f"{agent_label} can run again. Do not repeat its work yourself. "
            "All member contributions will be rerun after this repair."
        )
        return FailureDecision("repair", 0, state)
    if mode in ("ask", "review"):
        failures = list(state.get(PARTICIPANT_FAILURES_STATE_KEY) or [])
        failures.append(
            {
                "assignmentId": assignments[index].get("assignmentId"),
                "agent": agent_label,
                "mode": mode,
                "outcome": outcome,
            }
        )
        state[PARTICIPANT_FAILURES_STATE_KEY] = failures
        return FailureDecision("continue", index + 1, state)
    return FailureDecision("fail", None, state)


def advance_after_success(
    run_request: dict[str, Any], next_state: dict[str, Any]
) -> tuple[int, dict[str, Any]]:
    """Advance normally, or resume work after a coordinator repair."""
    index = run_request.get("currentIndex", 0)
    state = dict(next_state)
    resume_index = state.get(REPAIR_RESUME_INDEX_STATE_KEY)
    if index != 0 or not isinstance(resume_index, int):
        return index + 1, state
    state.pop(REPAIR_RESUME_INDEX_STATE_KEY, None)
    state.pop(REPAIR_NOTE_STATE_KEY, None)
    return resume_index, state


def next_work_transition(
    run_request: dict[str, Any],
    assignment: dict[str, Any],
    work_result: dict[str, Any] | None,
    next_state: dict[str, Any],
    *,
    max_repairs: int,
) -> WorkTransition:
    """Choose the next turn of an evidence-gated round after a successful run.

    ``next_state`` already records this turn's report. Precedence: a pending
    consultation, then a findings repair, then the coordinator's plan; a
    required turn without accepted work then ends the round.
    """
    assignments = run_request["assignments"]
    index = run_request.get("currentIndex", 0)
    prior = run_request.get("state") or {}
    next_index: int | None
    next_index, state = advance_after_success(run_request, next_state)
    reported = work_result or {"status": "missing", "evidence": []}
    question = question_transition(assignments, index, state, reported)
    if question:
        return WorkTransition(*question)
    if QUESTION_RESUME in state:
        return WorkTransition(None, {**state, WORK_PLAN_ERROR: MISSING_ANSWER_ERROR})
    repair = repair_transition(assignments, index, state, max_repairs=max_repairs)
    if repair:
        return WorkTransition(*repair)
    is_planning_turn = (
        index == 0
        and assignment.get("coordinator") is True
        and not prior.get(REPAIR_NOTE_STATE_KEY)
    )
    if work_result is None or work_result.get("status") != "done":
        style = (assignment.get("teamSnapshot") or {}).get("collaborationStyle")
        may_inspect = (
            work_result is None
            and next_index < len(assignments)
            and style in INSPECTING_STYLES
            and not assignment.get("coordinator")
        )
        if assignment.get("required", True) and not may_inspect:
            next_index = None
    elif (
        is_planning_turn
        and len(assignments) > 1
        and state.get(COLLABORATION_MANIFEST_STATE_KEY)
        and "plan" not in work_result
        and QUESTION_RESUME not in prior
    ):
        return WorkTransition(None, {**state, WORK_PLAN_ERROR: MISSING_PLAN_ERROR})
    plan = (
        work_result["plan"]
        if is_planning_turn and next_index is not None and work_result and "plan" in work_result
        else None
    )
    return WorkTransition(next_index, state, plan)


def assignment_reports_round_result(
    assignments: list[dict[str, Any]], index: int
) -> bool:
    """Return whether this assignment owns the aggregate result adapter."""
    if index < 0 or index >= len(assignments):
        return False
    if (assignments[index].get("mode") or "action") == "ask":
        return False
    synthesizers = [
        position
        for position, assignment in enumerate(assignments)
        if assignment.get("synthesizer") is True
    ]
    if synthesizers:
        return index == synthesizers[-1]
    return not any(
        (assignment.get("mode") or "action") != "ask"
        for assignment in assignments[index + 1 :]
    )


def validate_round_result(event: dict[str, Any]) -> dict[str, Any] | None:
    """Validate the untrusted result envelope relayed by a daemon adapter."""
    reported = event.get("roundResult")
    if not isinstance(reported, dict):
        return None
    status = reported.get("status")
    if status not in ROUND_RESULT_STATUSES:
        return None
    note = reported.get("note")
    return {
        "status": status,
        **(
            {"note": note.strip()[:ROUND_RESULT_NOTE_MAX_CHARS]}
            if isinstance(note, str) and note.strip()
            else {}
        ),
    }
