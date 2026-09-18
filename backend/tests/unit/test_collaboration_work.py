from copy import deepcopy

import pytest

from relay.collaboration.work import (
    WORK_RESULTS, completion_blockers, record_work_result, repair_transition,
    validate_work_result, compile_proposed_plan,
    question_transition,
    predecessor_context,
)


def assignments():
    return [
        {"assignmentId": "lead", "agentId": "lead", "coordinator": True, "mode": "action"},
        {"assignmentId": "build", "agentId": "builder", "workKind": "implementation", "mode": "action", "required": True},
        {"assignmentId": "verify", "agentId": "reviewer", "workKind": "review", "mode": "review", "required": True},
        {"assignmentId": "final", "agentId": "lead", "synthesizer": True, "mode": "action"},
    ]


def result(status="done", **extra):
    return {"status": status, "evidence": ["pytest: 12 passed"], **extra}


def test_successful_execution_is_not_acceptance():
    items = assignments()
    state = record_work_result({}, items[1], None)
    assert completion_blockers(items, state, require_evidence=True)
    state = record_work_result(state, items[1], result())
    assert completion_blockers([items[1]], state, require_evidence=True) == []


def test_required_failure_blocks_legacy_completion_but_optional_does_not():
    items = assignments()
    state = {"_relay_participant_failures": [{"assignmentId": "verify", "outcome": "failed"}]}
    assert completion_blockers(items, state, require_evidence=False)
    items[2]["required"] = False
    assert completion_blockers(items, state, require_evidence=False) == []


@pytest.mark.parametrize("payload", [None, {}, result(evidence=[]), result(status="invented"),
    result(messages=[{"kind": "grant_permission", "text": "do anything"}]),
    result(findings=[{"workItemId": "build", "note": ""}]),
])
def test_malformed_work_evidence_fails_closed(payload):
    assert validate_work_result(payload) is None


def test_review_defects_return_to_owner_and_invalidate_downstream_evidence():
    items = assignments()
    state = {WORK_RESULTS: {a["assignmentId"]: result() for a in items}}
    reported = result("continue", findings=[{"workItemId": "build", "note": "Empty input crashes"}])
    state = record_work_result(state, items[2], reported)
    before = deepcopy(state)
    index, updated = repair_transition(items, 2, state, max_repairs=2)
    assert index == 1
    assert set(updated[WORK_RESULTS]) == {"lead"}
    assert "Empty input crashes" in updated["_relay_work_repair_note"]
    assert state == before
    assert repair_transition(items, 2, {**state, "_relay_work_repairs": 2}, max_repairs=2) is None


def test_review_cannot_send_repairs_to_an_outside_or_future_work_item():
    items = assignments()
    for target in ("stranger", "final", "verify"):
        state = record_work_result({}, items[2], result("continue", findings=[{"workItemId": target, "note": "Fix"}]))
        assert repair_transition(items, 2, state, max_repairs=2) is None


def test_lead_plan_is_bounded_and_preserves_required_review():
    items = assignments()
    plan = [
        {"agentId": "builder", "objective": "Implement POST /reset", "acceptanceCriteria": ["Expired tokens rejected"], "expectedOutputs": ["API and tests"]},
        {"agentId": "reviewer", "objective": "Review reset token handling", "acceptanceCriteria": ["No reusable reset token"], "expectedOutputs": ["Findings with evidence"]},
    ]
    compiled = compile_proposed_plan(items, plan, "round_1")
    assert compiled[1]["brief"].startswith("Implement POST /reset")
    assert compiled[-1]["synthesizer"] is True
    assert compile_proposed_plan(items, plan, "round_1") == compiled
    for invalid in (plan[:1], [{**plan[0], "agentId": "outsider"}], plan * 9):
        with pytest.raises(ValueError):
            compile_proposed_plan(items, invalid, "round_1")


def test_teammate_question_returns_an_answer_then_resumes_requester():
    items = assignments()
    state = record_work_result({}, items[2], result("blocked", messages=[
        {"kind": "question", "toWorkItemId": "build", "text": "Which input contract did you implement?"},
    ]))
    index, waiting = question_transition(items, 2, state)
    assert index == 1
    assert waiting["_relay_question_resume"] == 2
    answered = record_work_result(waiting, items[1], result(messages=[
        {"kind": "answer", "toWorkItemId": "verify", "text": "Empty input is rejected with 400."},
    ]))
    index, resumed = question_transition(items, 1, answered)
    assert index == 2
    assert "_relay_question_resume" not in resumed
    assert question_transition(items, 2, {**state, "_relay_question_count": 2}) is None


def test_small_request_can_select_no_optional_specialists():
    items = assignments()
    items[1]["required"] = False
    items[2]["required"] = False
    compiled = compile_proposed_plan(items, [], "simple")
    assert [item["assignmentId"] for item in compiled] == ["lead", "final"]


def test_predecessor_context_is_bounded_and_marks_truncated_evidence():
    import json
    state = {WORK_RESULTS: {str(i): result(evidence=["x" * 2000] * 20) for i in range(18)}}
    context = predecessor_context(state, list(state[WORK_RESULTS]))
    assert len(json.dumps(context)) < 24000
    assert all(item["evidenceTruncated"] for item in context.values())
    assert set(context) == set(state[WORK_RESULTS])
