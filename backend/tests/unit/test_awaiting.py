"""A task's wait: the record every park writes, and the one projection of it."""

from __future__ import annotations

from typing import Any

import pytest

from relay.collaboration.awaiting import plain_gate_reason, read_waiting_reason, task_awaiting
from relay.core.human_waits import (
    ensure_wait_record,
    question_id_for_run,
    wait_record,
)
from relay.persistence.task.lifecycle import acceptance_status


def _waiting(**fields: Any) -> dict[str, Any]:
    return {"id": "task_1", "status": "waiting_for_human", "waitingSessionId": "ses_1", **fields}


def test_a_run_asks_the_same_question_on_every_retry() -> None:
    assert question_id_for_run("req_1") == question_id_for_run("req_1") == "q_req_1"


def test_a_park_without_a_record_still_gets_an_id_an_answer_can_name() -> None:
    minted = ensure_wait_record(None)
    assert minted["questionId"].startswith("q_") and minted["kind"] == "check"
    asked = ensure_wait_record({"inputQuestion": "Which vault?"})
    assert asked["kind"] == "question" and asked["inputQuestion"] == "Which vault?"
    kept = wait_record("budget", "q_fixed")
    assert ensure_wait_record(kept) == kept


def test_an_unknown_wait_kind_is_refused() -> None:
    with pytest.raises(ValueError):
        wait_record("vote", "q_1")  # type: ignore[arg-type]


def test_a_question_projects_its_words_answers_and_notes() -> None:
    task = _waiting(
        waitingReason="The round reported it is blocked. Which vault? 1 participant failed.",
        waitingRequest=wait_record(
            "question", "q_req_1", question="Which vault?",
            options=["Ops", " Ops ", "Shared"], notes=["A required step failed to run.", " "],
        ),
    )
    assert task_awaiting(task) == {
        "questionId": "q_req_1",
        "kind": "question",
        "text": "Which vault?",
        "options": ["Ops", "Shared"],
        "notes": ["A required step failed to run."],
        "sessionId": "ses_1",
        "resumable": True,
    }


def test_a_gate_stop_quotes_its_reason_without_the_preamble() -> None:
    task = _waiting(
        waitingReason="The work can't be accepted yet. A required step failed to run.",
        waitingRequest=wait_record("check", "q_req_2"),
    )
    awaiting = task_awaiting(task)
    assert awaiting["kind"] == "check"
    assert awaiting["text"] == "A required step failed to run."
    assert awaiting["options"] == []


def test_a_spent_budget_is_its_own_kind() -> None:
    awaiting = task_awaiting(_waiting(
        waitingReason="The task used its 5-round budget without reporting it was finished.",
        waitingRequest=wait_record("budget", "q_3"),
    ))
    assert awaiting["kind"] == "budget"
    assert "5-round budget" in awaiting["text"]


def test_an_approval_names_who_takes_the_held_step() -> None:
    awaiting = task_awaiting(_waiting(
        waitingReason="Waiting for approval before the next step.",
        waitingRequest=wait_record("approval", "q_req_9", next_agent_id="agt_reviewer"),
    ))
    assert awaiting["kind"] == "approval"
    assert awaiting["questionId"] == "q_req_9"
    assert awaiting["nextAgentId"] == "agt_reviewer"
    assert awaiting["options"] == []
    # Only an approval carries the next agent.
    assert "nextAgentId" not in wait_record("check", "q_1", next_agent_id="agt_x")


def test_a_wait_recorded_before_ids_still_projects() -> None:
    legacy_question = task_awaiting({
        "status": "waiting_for_human",
        "waitingReason": "The round reported it is blocked. Use staging or prod?",
    })
    assert legacy_question["questionId"] is None
    assert legacy_question["sessionId"] is None
    assert (legacy_question["kind"], legacy_question["text"]) == ("question", "Use staging or prod?")
    legacy_gate = task_awaiting(_waiting(
        waitingReason="Work needs attention. Work 6fc1d579 is not accepted: missing.",
    ))
    assert (legacy_gate["kind"], legacy_gate["text"]) == (
        "check", "A required step ended without reporting what it did.",
    )


def test_only_a_live_waiting_task_projects_a_wait() -> None:
    assert task_awaiting({"status": "running"}) is None
    assert task_awaiting(_waiting(deletedAt="2026-10-16T00:00:00Z")) is None
    assert task_awaiting(_waiting(isRoutine=True))["resumable"] is False


def test_legacy_gate_reasons_are_reworded_and_others_quoted() -> None:
    assert plain_gate_reason(
        "Work needs attention. Required contribution a1 failed. "
        "Work b2 is not accepted: tests still red. Unresolved finding on b2: crash"
    ) == (
        "A required step failed to run. A required step is not finished: tests still red. "
        "A review found a problem that is still open: crash"
    )
    assert read_waiting_reason("Execution needs attention.") == ("check", "Execution needs attention.")
    assert read_waiting_reason("The round reported it is blocked.") == ("question", None)


def test_a_reason_recorded_once_per_step_is_quoted_once() -> None:
    missing = "A required step ended without reporting what it did."
    assert plain_gate_reason(f"The work can't be accepted yet. {missing} {missing}") == missing
    assert plain_gate_reason(
        "Work needs attention. Work a1 is not accepted: missing. Work b2 is not accepted: missing. "
        "Required contribution c3 failed."
    ) == f"{missing} A required step failed to run."


@pytest.mark.parametrize("policy,status,human,expected", [
    ("human", "done", False, "review"),
    ("human", "done", True, "done"),
    ("automatic", "done", False, "done"),
    ("human", "waiting_for_human", False, "waiting_for_human"),
])
def test_acceptance_status_sends_human_acceptance_work_to_review(policy, status, human, expected) -> None:
    task = {"acceptancePolicy": policy}
    assert acceptance_status(task, status, accepted_by_human=human) == expected


def test_an_unreported_check_says_so_and_only_a_check_can_be_unreported() -> None:
    missing = "A required step ended without reporting what it did."
    task = _waiting(
        waitingReason=f"The work can't be accepted yet. {missing}",
        waitingRequest=wait_record("check", "q_req_1", unreported=True),
    )
    awaiting = task_awaiting(task)
    assert awaiting is not None
    assert awaiting["kind"] == "check" and awaiting["unreported"] is True
    assert awaiting["text"] == missing
    assert "unreported" not in wait_record("question", "q_req_2", question="Which?", unreported=True)
    assert "unreported" not in (task_awaiting(_waiting(waitingRequest=wait_record("check", "q_3"))) or {})
