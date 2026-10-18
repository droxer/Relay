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
    is_answer_turn,
    question_transition,
    repair_transition,
    repairs_used,
)

# Coordinator runtime-failure repairs per round. A sub-budget of the round's
# shared ``MAX_REPAIRS``; ``RELAY_DAEMON_RUN_MAX_REPAIRS`` overrides it.
DEFAULT_RUNTIME_FAILURE_REPAIRS = 1

REPAIR_COUNT_STATE_KEY = RUNTIME_REPAIRS
REPAIR_RESUME_INDEX_STATE_KEY = "_relay_repair_resume_index"
REPAIR_NOTE_STATE_KEY = "_relay_repair_note"
ROUND_RESULT_STATE_KEY = "_relay_round_result"
PARTICIPANT_FAILURES_STATE_KEY = "_relay_participant_failures"
ROUND_RESULT_STATUSES = frozenset({"done", "continue", "blocked"})
# What a blocked round's outcome says before the agent's own note. Older
# threads carry their question only inside this outcome, so the conversation
# replay and the web (`BLOCKED_ROUND_PREAMBLE` in web/src/lib/awaitingInput.ts)
# match on it: change it in all three places or not at all.
BLOCKED_ROUND_PREAMBLE = "The round reported it is blocked."
ROUND_RESULT_NOTE_MAX_CHARS = 2000
# A blocked round may offer the answers it expects, so a person can pick one
# instead of typing. Bounded: they render as buttons under the question.
ROUND_RESULT_OPTIONS_MAX = 6
ROUND_RESULT_OPTION_MAX_CHARS = 200
# Why a daemon refused a verdict file it found (`roundResultRejected` on
# run.completed; the codes mirror relay-core's DaemonRoundResultRejectionReason),
# worded to finish "was rejected because ...".
ROUND_RESULT_REJECTED_STATE_KEY = "_relay_round_result_rejected"
ROUND_RESULT_REJECTIONS = {
    "oversize": "it was larger than 64KB",
    "malformed": "it was not valid JSON",
    "not_object": "it was not a JSON object",
    "invalid_status": "its status was not done, continue, or blocked",
    "run_id_mismatch": "its runId did not match this run",
}


# Styles whose next member can still inspect the workspace when a member
# finished without a report; the completion gate still rejects the gap.
INSPECTING_STYLES = frozenset({"build_review", "pipeline", "lead_led"})
MISSING_ANSWER_ERROR = "The requested teammate answer was not provided."
MISSING_PLAN_ERROR = "The coordinator did not provide a bounded work plan."
# A required step that ended without filing any report is asked once, in the
# same round, to file it before the round parks on its human: the agent knows
# whether its work is done, so it decides. Separate from the repair budget,
# which pays for reruns of work, not for a missing verdict.
REPORT_REMINDED_STATE_KEY = "_relay_report_reminded"
REPORT_REMINDER_TARGET_STATE_KEY = "_relay_report_reminder_target"
REPORT_REMINDER_NOTE = (
    "Your last turn ended without writing the round result file, so Relay "
    "cannot tell whether the work is finished. Check the workspace and the "
    "conversation above, then decide. If real work remains, do it now. Then "
    'write the file: "done" when the requested work is complete, or '
    '"blocked" with your question if you need the human. Do not redo work '
    "that is already finished."
)


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
    max_runtime_repairs: int = DEFAULT_RUNTIME_FAILURE_REPAIRS,
) -> FailureDecision:
    """Choose the next collaboration action without performing delivery I/O.

    A coordinator's runtime-failure repair spends both its own budget
    (``max_runtime_repairs``) and the round's shared rerun budget
    (``MAX_REPAIRS``), so findings repairs and runtime repairs together never
    rerun the member sequence more than ``MAX_REPAIRS`` times.
    """
    assignments = run_request["assignments"]
    index = run_request.get("currentIndex", 0)
    state = dict(next_state)
    repairs = int(state.get(REPAIR_COUNT_STATE_KEY) or 0)
    can_repair = (
        bool(run_request.get("taskId"))
        and index > 0
        and len(assignments) >= 2
        and repairs < max_runtime_repairs
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
    max_repairs: int = MAX_REPAIRS,
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
    state = without_report_reminder(state)
    reported = work_result or {"status": "missing", "evidence": []}
    question = question_transition(assignments, index, state, reported)
    if question:
        return WorkTransition(*question)
    if QUESTION_RESUME in state:
        return WorkTransition(None, {**state, WORK_PLAN_ERROR: MISSING_ANSWER_ERROR})
    repair = repair_transition(assignments, index, state, max_repairs=max_repairs)
    if repair:
        return WorkTransition(*repair)
    reminder = report_reminder_transition(
        run_request, assignment, state, unreported=work_result is None
    )
    if reminder:
        return WorkTransition(*reminder)
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
    # A solo team's coordinator is its whole round: a plan would only queue
    # the same assignment again.
    plan = (
        work_result["plan"]
        if is_planning_turn
        and len(assignments) > 1
        and next_index is not None
        and work_result
        and "plan" in work_result
        else None
    )
    return WorkTransition(next_index, state, plan)


def without_report_reminder(state: dict[str, Any]) -> dict[str, Any]:
    """``state`` without the reminder target: a reminder speaks to one turn."""
    return {key: value for key, value in state.items() if key != REPORT_REMINDER_TARGET_STATE_KEY}


def report_reminder_transition(
    run_request: dict[str, Any],
    assignment: dict[str, Any],
    state: dict[str, Any],
    *,
    unreported: bool,
) -> tuple[int, dict[str, Any]] | None:
    """Rerun a required step that owed a report and filed none, once per round.

    ``unreported`` is the caller's reading of what this turn owed: a work
    report under the work protocol, else the round's verdict. A verdict the
    daemon refused was filed, and an answer turn keeps the contribution it
    answers for; neither is reminded.
    """
    index = run_request.get("currentIndex", 0)
    reminded = list(state.get(REPORT_REMINDED_STATE_KEY) or [])
    if (
        not unreported
        or not assignment.get("required", True)
        or assignment["assignmentId"] in reminded
        or ROUND_RESULT_STATE_KEY in state
        or ROUND_RESULT_REJECTED_STATE_KEY in state
        or is_answer_turn(run_request.get("state") or {}, index)
    ):
        return None
    return index, {
        **without_report_reminder(state),
        REPORT_REMINDED_STATE_KEY: [*reminded, assignment["assignmentId"]],
        REPORT_REMINDER_TARGET_STATE_KEY: assignment["assignmentId"],
    }


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
    offered = _distinct_options(reported.get("options")) if status == "blocked" else []
    options = offered if len(offered) >= 2 else []
    if len(offered) == 1 and not (isinstance(note, str) and note.strip()):
        # One option is not a choice, but it is what the agent meant to ask;
        # without a note, dropping it would leave the human nothing to answer.
        note = f"Proposed answer: {offered[0]}"
    return {
        "status": status,
        **(
            {"note": note.strip()[:ROUND_RESULT_NOTE_MAX_CHARS]}
            if isinstance(note, str) and note.strip()
            else {}
        ),
        **({"options": options} if options else {}),
    }


def is_question(round_result: dict[str, Any] | None) -> bool:
    """Whether a verdict stopped to ask its human something."""
    return (
        isinstance(round_result, dict)
        and round_result.get("status") == "blocked"
        and bool(round_result.get("note") or round_result.get("options"))
    )


def round_result_options(raw: Any) -> list[str]:
    """The answers a blocked round offers: trimmed, distinct, bounded.

    One option is not a choice, so fewer than two offers nothing."""
    options = _distinct_options(raw)
    return options if len(options) >= 2 else []


def _distinct_options(raw: Any) -> list[str]:
    if not isinstance(raw, list):
        return []
    options: list[str] = []
    for item in raw:
        if not isinstance(item, str):
            continue
        text = " ".join(item.split())[:ROUND_RESULT_OPTION_MAX_CHARS]
        if text and text not in options:
            options.append(text)
        if len(options) == ROUND_RESULT_OPTIONS_MAX:
            break
    return options
