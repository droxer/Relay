from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Literal

from .work import (
    QUESTION_NOTE,
    QUESTION_RESUME,
    QUESTION_TARGET,
    WORK_REPAIR_NOTE,
    WORK_REPAIR_TARGET,
    WORK_RESULTS,
)

REPAIR_COUNT_STATE_KEY = "_relay_repair_count"
REPAIR_RESUME_INDEX_STATE_KEY = "_relay_repair_resume_index"
REPAIR_NOTE_STATE_KEY = "_relay_repair_note"
ROUND_RESULT_STATE_KEY = "_relay_round_result"
PARTICIPANT_FAILURES_STATE_KEY = "_relay_participant_failures"
ROUND_RESULT_STATUSES = frozenset({"done", "continue", "blocked"})
ROUND_RESULT_NOTE_MAX_CHARS = 2000


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
