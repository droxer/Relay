"""Where an approval holds a round, and how its answer resumes it (ADR-023)."""

from __future__ import annotations

from typing import Any

import pytest

from relay.collaboration.approvals import (
    APPROVED_INDEX_STATE_KEY,
    PARKED_INDEX_STATE_KEY,
    ApprovalResumeError,
    approval_resume,
    awaits_approval,
)
from relay.collaboration.work import WORK_RESULTS, WORK_REPAIR_TARGET
from relay.teams.dispatch import team_member_assignments


def _agent(agent_id: str, role: str) -> dict[str, Any]:
    return {"id": agent_id, "executorKind": "claude", "defaultRole": role}


def _team(style: str, *, approval: bool = True) -> dict[str, Any]:
    return {
        "id": "t", "leadAgentId": "b", "memberAgentIds": ["b", "r"],
        "collaborationStyle": style, **({"humanApproval": True} if approval else {}),
    }


def _request(**fields: Any) -> dict[str, Any]:
    return {
        "taskId": "task_1",
        "currentIndex": 1,
        "assignments": [{"agentId": "b"}, {"agentId": "r", "awaitApproval": True}],
        "state": {},
        **fields,
    }


@pytest.mark.parametrize("style", ["build_review", "pipeline"])
def test_only_the_closing_turn_waits_for_approval(style: str) -> None:
    assignments = team_member_assignments(
        [_agent("b", "implementer"), _agent("r", "reviewer")], team=_team(style), style=style
    )
    assert [bool(item.get("awaitApproval")) for item in assignments] == [False, True]
    assert assignments[1]["teamSnapshot"]["humanApproval"] is True


def test_a_one_turn_round_and_a_team_without_approval_hold_nothing() -> None:
    solo = team_member_assignments(
        [_agent("b", "implementer")], team={**_team("build_review"), "memberAgentIds": ["b"]},
        style="build_review",
    )
    assert not any(item.get("awaitApproval") for item in solo)
    plain = team_member_assignments(
        [_agent("b", "implementer"), _agent("r", "reviewer")],
        team=_team("build_review", approval=False), style="build_review",
    )
    assert not any(item.get("awaitApproval") for item in plain)


def test_a_task_round_waits_until_its_held_turn_is_approved() -> None:
    assert awaits_approval(_request())
    assert not awaits_approval(_request(currentIndex=0))
    assert not awaits_approval(_request(state={APPROVED_INDEX_STATE_KEY: 1}))
    # A thread with no task has nothing an answer could resume.
    assert not awaits_approval(_request(taskId=None))
    assert not awaits_approval(_request(currentIndex=2))


def test_approving_runs_the_held_turn_with_the_evidence_so_far() -> None:
    parked = _request(state={
        PARKED_INDEX_STATE_KEY: 1,
        WORK_RESULTS: {"w_b": {"status": "done"}},
        WORK_REPAIR_TARGET: "w_b",
        "_relay_task_source_revision": 4,
    })
    index, state = approval_resume(parked, approve=True)
    assert index == 1
    assert state == {WORK_RESULTS: {"w_b": {"status": "done"}}, APPROVED_INDEX_STATE_KEY: 1}


def test_asking_for_changes_reruns_the_turn_before_and_asks_again() -> None:
    parked = _request(state={PARKED_INDEX_STATE_KEY: 1, WORK_RESULTS: {}})
    index, state = approval_resume(parked, approve=False)
    assert index == 0
    assert APPROVED_INDEX_STATE_KEY not in state


@pytest.mark.parametrize("recorded", [None, 0, 2, True, "1"])
def test_a_parked_round_without_a_resumable_step_is_refused(recorded: Any) -> None:
    state = {} if recorded is None else {PARKED_INDEX_STATE_KEY: recorded}
    with pytest.raises(ApprovalResumeError):
        approval_resume(_request(state=state), approve=True)
