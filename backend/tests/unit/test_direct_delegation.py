from copy import deepcopy

import pytest

from relay.collaboration.work import validate_work_result
from relay.collaboration.policy import next_work_transition, decide_failure
from store_fixtures import make_agent_store


def proposal(**patch):
    return {"agentId": "b", "objective": "Write sign-in tests", "context": "Use existing fixtures",
            "acceptanceCriteria": ["Session expiry is covered"], "expectedOutputs": ["tests/test_login.py"], **patch}


def test_work_report_preserves_a_bounded_delegation():
    report = validate_work_result({"status": "continue", "delegation": proposal()})
    assert report is not None and report["delegation"] == proposal()


@pytest.mark.parametrize("patch", [
    {"agentId": ""}, {"objective": " "}, {"objective": "x" * 4001},
    {"acceptanceCriteria": []}, {"expectedOutputs": []}, {"context": 123},
    {"executorKind": "claude"},
])
def test_malformed_delegation_is_rejected(patch):
    assert validate_work_result({"status": "continue", "delegation": proposal(**patch)}) is None


def test_done_report_cannot_also_delegate():
    assert validate_work_result({"status": "done", "evidence": ["done"], "delegation": proposal()}) is None


def test_delegation_permissions_survive_store_reload(tmp_path):
    store = make_agent_store(tmp_path)
    agent = store.create_agent("alice", {"displayName": "A", "executorKind": "codex", "defaultRole": "implementer"})
    updated = store.update_agent(agent["id"], {"delegationAgentIds": ["b", "b"]})
    assert updated["delegationAgentIds"] == ["b"]
    assert make_agent_store(tmp_path).get_agent(agent["id"])["delegationAgentIds"] == ["b"]


def test_child_blocker_returns_control_to_requester_without_accepting_child_work():
    child = {"assignmentId": "child", "agentId": "b", "delegatedByAgentId": "a", "required": False}
    resume = {"assignmentId": "resume", "agentId": "a", "mode": "action"}
    request = {"assignments": [child, resume], "currentIndex": 0}
    state = {"_relay_round_result": {"status": "done"}}
    before = deepcopy(state)
    transition = next_work_transition(request, child, {"status": "blocked", "evidence": [], "note": "Fixture missing"}, state)
    assert transition.next_index == 1
    assert "_relay_round_result" not in transition.state
    assert state == before


def test_child_runtime_failure_returns_control_to_requester():
    request = {"assignments": [
        {"assignmentId": "child", "agentId": "b", "delegatedByAgentId": "a"},
        {"assignmentId": "resume", "agentId": "a"},
    ], "currentIndex": 0}
    decision = decide_failure(request, {}, outcome="Runtime failed", agent_label="B", mode="action")
    assert decision.kind == "continue" and decision.next_index == 1
    assert decision.state["_relay_work_results"]["child"]["status"] == "blocked"
