"""Approval steps: where a round waits for its person, and how it resumes.

A team with `humanApproval` marks the turn that closes its round
`awaitApproval` (ADR-023). The registry parks a task round before delivering
that turn, and the person's answer starts a round that picks the same work
back up: approving runs the held turn, asking for changes reruns the turn
before it and asks again. Pure rules; the registry parks and the conductor
resumes.
"""

from __future__ import annotations

from typing import Any

from .policy import PARTICIPANT_FAILURES_STATE_KEY
from .work import QUESTION_COUNT, RUNTIME_REPAIRS, WORK_REPAIRS, WORK_RESULTS

# The index of the held turn the person approved; that turn then runs.
APPROVED_INDEX_STATE_KEY = "_relay_approved_index"
# The index a round parked at, recorded on the request it closed.
PARKED_INDEX_STATE_KEY = "_relay_approval_parked_index"
# What the closed thread says while it waits. Surfaces word the wait from its
# kind; this is the transcript's line.
APPROVAL_OUTCOME = "Waiting for approval before the next step."
# What a resumed round keeps from the one it continues: the evidence filed so
# far and the budgets already spent. Routing for a pending repair or question
# is not carried; the resumed round starts at a turn boundary.
RESUMED_STATE_KEYS = (
    WORK_RESULTS,
    WORK_REPAIRS,
    RUNTIME_REPAIRS,
    QUESTION_COUNT,
    PARTICIPANT_FAILURES_STATE_KEY,
)


class ApprovalResumeError(ValueError):
    """The parked round cannot be resumed as recorded."""


def awaits_approval(run_request: dict[str, Any]) -> bool:
    """Whether the round must wait for its person before its current turn.

    Only a task round parks: a wait lives on its task, and a thread with no
    task has nothing an answer could resume, so it runs straight through.
    """
    index = run_request.get("currentIndex", 0)
    assignments = run_request.get("assignments") or []
    if not run_request.get("taskId") or not 0 <= index < len(assignments):
        return False
    state = run_request.get("state") or {}
    return (
        assignments[index].get("awaitApproval") is True
        and state.get(APPROVED_INDEX_STATE_KEY) != index
    )


def approval_resume(
    parked: dict[str, Any], *, approve: bool
) -> tuple[int, dict[str, Any]]:
    """The index and carried state of the round an answer starts.

    Approving runs the held turn. Asking for changes reruns the turn before
    it, which then reaches the held turn and asks again: the person sees the
    reworked result before anyone builds on it.
    """
    state = parked.get("state") or {}
    index = state.get(PARKED_INDEX_STATE_KEY)
    assignments = parked.get("assignments") or []
    if (
        not isinstance(index, int)
        or isinstance(index, bool)
        or not 0 < index < len(assignments)
    ):
        raise ApprovalResumeError("The parked round has no step to resume.")
    carried = {key: state[key] for key in RESUMED_STATE_KEYS if key in state}
    if approve:
        return index, {**carried, APPROVED_INDEX_STATE_KEY: index}
    return index - 1, carried
