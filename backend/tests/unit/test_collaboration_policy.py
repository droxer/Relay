from __future__ import annotations

from copy import deepcopy

from relay.collaboration.models import COLLABORATION_MANIFEST_STATE_KEY
from relay.collaboration.policy import (
    REPAIR_COUNT_STATE_KEY,
    REPAIR_NOTE_STATE_KEY,
    REPAIR_RESUME_INDEX_STATE_KEY,
    advance_after_success,
    assignment_reports_round_result,
    decide_failure,
    next_work_transition,
    validate_round_result,
)
from relay.collaboration.work import (
    QUESTION_NOTE,
    QUESTION_RESUME,
    QUESTION_TARGET,
    WORK_PLAN_ERROR,
    WORK_REPAIRS,
    WORK_RESULTS,
    record_work_result,
    repair_transition,
)


def _request(**overrides):
    return {
        "taskId": "task_1",
        "currentIndex": 1,
        "assignments": [
            {"assignmentId": "a1", "mode": "action", "coordinator": True},
            {"assignmentId": "a2", "mode": "action"},
        ],
        "state": {},
        **overrides,
    }


def test_action_failure_requests_one_explicit_coordinator_repair() -> None:
    decision = decide_failure(
        _request(),
        {},
        outcome="Builder action failed.",
        agent_label="Builder",
        mode="action",
        max_repairs=1,
    )

    assert decision.kind == "repair"
    assert decision.next_index == 0
    assert decision.state[REPAIR_RESUME_INDEX_STATE_KEY] == 1
    assert "Builder" in decision.state[REPAIR_NOTE_STATE_KEY]


def test_taskless_failure_never_invents_coordinator_authority() -> None:
    decision = decide_failure(
        _request(taskId=None),
        {},
        outcome="Builder action failed.",
        agent_label="Builder",
        mode="action",
        max_repairs=1,
    )

    assert decision.kind == "fail"


def test_coordinator_repair_discards_stale_evidence_and_restarts_member_work():
    state = {
        WORK_RESULTS: {key: {"status": "done", "evidence": ["Old checks"]} for key in ("lead", "build", "verify")},
        "_relay_round_result": {"status": "done"},
        "_relay_participant_failures": [{"assignmentId": "verify"}],
        QUESTION_RESUME: 3, QUESTION_TARGET: 2, QUESTION_NOTE: "Old consultation",
    }
    before = deepcopy(state)
    request = _request(currentIndex=3, assignments=[
        {"assignmentId": "lead", "coordinator": True},
        {"assignmentId": "build"}, {"assignmentId": "verify"}, {"assignmentId": "review"},
    ])
    decision = decide_failure(request, state, outcome="Review failed", agent_label="Reviewer", mode="review", max_repairs=1)
    assert decision.kind == "repair"
    assert not decision.state.get(WORK_RESULTS)
    assert "_relay_round_result" not in decision.state
    assert not decision.state.get("_relay_participant_failures")
    assert not any(key in decision.state for key in (QUESTION_RESUME, QUESTION_TARGET, QUESTION_NOTE))
    next_index, _ = advance_after_success({**request, "currentIndex": 0}, decision.state)
    assert next_index == 1
    assert state == before


def test_discussion_failure_keeps_collecting_participants() -> None:
    request = _request(
        currentIndex=0,
        assignments=[
            {"assignmentId": "a1", "mode": "ask"},
            {"assignmentId": "a2", "mode": "ask"},
        ],
    )
    decision = decide_failure(
        request,
        {},
        outcome="Researcher ask failed.",
        agent_label="Researcher",
        mode="ask",
        max_repairs=1,
    )

    assert decision.kind == "continue"
    assert decision.next_index == 1
    assert decision.state["_relay_participant_failures"][0]["assignmentId"] == "a1"


def test_successful_repair_resumes_the_failed_assignment() -> None:
    next_index, state = advance_after_success(
        _request(currentIndex=0),
        {
            REPAIR_RESUME_INDEX_STATE_KEY: 1,
            REPAIR_NOTE_STATE_KEY: "repair it",
        },
    )

    assert next_index == 1
    assert REPAIR_RESUME_INDEX_STATE_KEY not in state
    assert REPAIR_NOTE_STATE_KEY not in state


def test_only_the_last_writable_assignment_reports_the_round_result() -> None:
    assignments = [
        {"mode": "action"},
        {"mode": "ask"},
        {"mode": "review"},
    ]

    assert assignment_reports_round_result(assignments, 0) is False
    assert assignment_reports_round_result(assignments, 1) is False
    assert assignment_reports_round_result(assignments, 2) is True


def test_explicit_review_synthesizer_owns_the_round_result() -> None:
    assignments = [
        {"assignmentId": "reviewer", "mode": "review"},
        {"assignmentId": "lead", "mode": "review", "synthesizer": True},
    ]

    assert assignment_reports_round_result(assignments, 0) is False
    assert assignment_reports_round_result(assignments, 1) is True


def test_round_result_adapter_rejects_unknown_status_and_caps_notes() -> None:
    assert validate_round_result({"roundResult": {"status": "maybe"}}) is None
    assert validate_round_result(
        {"roundResult": {"status": "continue", "note": " x "}}
    ) == {"status": "continue", "note": "x"}


def test_round_result_keeps_a_blocked_rounds_choices_only() -> None:
    offered = ["  Use   staging ", "Use prod", "Use prod", "", 3, *(f"o{n}" for n in range(9))]
    blocked = validate_round_result({"roundResult": {"status": "blocked", "options": offered}})
    assert blocked == {
        "status": "blocked",
        "options": ["Use staging", "Use prod", "o0", "o1", "o2", "o3"],
    }
    # Choices belong to a question; one option is no choice at all.
    assert "options" not in validate_round_result(
        {"roundResult": {"status": "done", "options": ["a", "b"]}}
    )
    assert "options" not in validate_round_result(
        {"roundResult": {"status": "blocked", "options": ["only"]}}
    )


def assignments():
    return [
        {"assignmentId": "lead", "agentId": "lead", "coordinator": True, "mode": "action"},
        {"assignmentId": "build", "agentId": "builder", "workKind": "implementation", "mode": "action"},
        {"assignmentId": "verify", "agentId": "reviewer", "workKind": "review", "mode": "review"},
        {"assignmentId": "final", "agentId": "lead", "synthesizer": True, "mode": "action"},
    ]


def result(status="done", **extra):
    return {"status": status, "evidence": ["pytest: 12 passed"], **extra}


def request(index, state=None):
    return {"assignments": assignments(), "currentIndex": index, "state": state or {}}


def answer(to="verify"):
    return result(
        evidence=["Answered the contract question"],
        messages=[{"kind": "answer", "toWorkItemId": to, "text": "Empty input is rejected."}],
    )


def test_answering_a_question_keeps_the_original_contribution_evidence():
    original = result(evidence=["Implemented POST /reset with tests"])
    waiting = {
        WORK_RESULTS: {"lead": result(), "build": original},
        QUESTION_RESUME: 2,
        QUESTION_TARGET: 1,
    }

    recorded = record_work_result(waiting, assignments()[1], answer(), answering=True)

    kept = recorded[WORK_RESULTS]["build"]
    assert kept["evidence"] == ["Implemented POST /reset with tests"]
    assert kept["messages"][-1]["kind"] == "answer"
    assert waiting[WORK_RESULTS]["build"] == original


def test_answer_turn_resumes_the_requester_and_keeps_original_evidence():
    original = result(evidence=["Implemented POST /reset with tests"])
    prior = {
        WORK_RESULTS: {"lead": result(), "build": original},
        QUESTION_RESUME: 2,
        QUESTION_TARGET: 1,
    }
    state = record_work_result(prior, assignments()[1], answer(), answering=True)

    transition = next_work_transition(
        request(1, prior), assignments()[1], answer(), state, max_repairs=2
    )

    assert transition.next_index == 2
    assert QUESTION_RESUME not in transition.state
    assert transition.state[WORK_RESULTS]["build"]["evidence"] == [
        "Implemented POST /reset with tests"
    ]


def test_a_blocked_answer_does_not_resume_the_requester():
    prior = {
        WORK_RESULTS: {"lead": result(), "build": result()},
        QUESTION_RESUME: 2,
        QUESTION_TARGET: 1,
    }
    blocked = {**answer(), "status": "blocked", "evidence": []}
    state = record_work_result(prior, assignments()[1], blocked, answering=True)

    transition = next_work_transition(
        request(1, prior), assignments()[1], blocked, state, max_repairs=2
    )

    assert transition.next_index is None
    assert transition.state[WORK_PLAN_ERROR]


def test_missing_required_report_ends_the_round():
    transition = next_work_transition(
        request(1), assignments()[1], None, {}, max_repairs=2
    )
    assert transition.next_index is None


def test_missing_report_in_a_styled_round_lets_the_next_member_inspect():
    items = assignments()
    for item in items:
        item["teamSnapshot"] = {"collaborationStyle": "lead_led"}
    run_request = {**request(1), "assignments": items}

    transition = next_work_transition(run_request, items[1], None, {}, max_repairs=2)

    assert transition.next_index == 2


def test_coordinator_plan_is_handed_back_for_compilation():
    plan = [{"agentId": "builder", "objective": "Build"}]
    state = {COLLABORATION_MANIFEST_STATE_KEY: {"roundId": "round_1"}}

    transition = next_work_transition(
        request(0), assignments()[0], result(plan=plan), state, max_repairs=2
    )

    assert transition.plan == plan
    assert transition.next_index == 1


def test_coordinator_without_a_plan_fails_closed():
    state = {COLLABORATION_MANIFEST_STATE_KEY: {"roundId": "round_1"}}

    transition = next_work_transition(
        request(0), assignments()[0], result(), state, max_repairs=2
    )

    assert transition.plan is None
    assert transition.next_index is None
    assert "work plan" in transition.state[WORK_PLAN_ERROR]


def test_coordinator_repair_turn_does_not_need_a_new_plan():
    prior = {REPAIR_NOTE_STATE_KEY: "Fix the runtime", "_relay_repair_resume_index": 1}
    state = {**prior, COLLABORATION_MANIFEST_STATE_KEY: {"roundId": "round_1"}}

    transition = next_work_transition(
        request(0, prior), assignments()[0], result(), state, max_repairs=2
    )

    assert transition.next_index == 1
    assert WORK_PLAN_ERROR not in transition.state


def test_review_findings_send_work_back_to_its_owner():
    state = record_work_result(
        {WORK_RESULTS: {"lead": result(), "build": result()}},
        assignments()[2],
        result("continue", findings=[{"workItemId": "build", "note": "Crashes"}]),
    )
    finding = state[WORK_RESULTS]["verify"]

    transition = next_work_transition(
        request(2), assignments()[2], finding, state, max_repairs=2
    )

    assert transition.next_index == 1
    assert transition.state[WORK_REPAIRS] == 1


def test_runtime_and_findings_repairs_share_one_budget():
    findings = record_work_result(
        {REPAIR_COUNT_STATE_KEY: 1, WORK_REPAIRS: 1},
        assignments()[2],
        result("continue", findings=[{"workItemId": "build", "note": "Crashes"}]),
    )
    assert repair_transition(assignments(), 2, findings, max_repairs=2) is None

    run_request = {**request(2), "taskId": "task_1"}
    decision = decide_failure(
        run_request,
        {WORK_REPAIRS: 2},
        outcome="Reviewer failed.",
        agent_label="Reviewer",
        mode="action",
        max_repairs=1,
    )
    assert decision.kind == "fail"
