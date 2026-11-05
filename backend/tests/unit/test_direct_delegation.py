from copy import deepcopy

import pytest

from relay.collaboration.work import validate_work_result
from relay.collaboration.policy import next_work_transition, decide_failure
from relay.collaboration.delegation import compile_delegation
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
    store.update_agent(agent["id"], {"delegationAgentIds": None})
    assert make_agent_store(tmp_path).get_agent(agent["id"])["delegationAgentIds"] is None


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


def test_compilation_is_deterministic_and_preserves_requester_responsibility():
    assignments = [{"assignmentId": "original", "agentId": "a", "daemonNodeId": "node", "required": True}]
    candidates = [{"agentId": "b", "daemonNodeId": "node", "executorKind": "codex", "agentInstructions": "Test carefully"}]
    before = deepcopy((assignments, candidates))
    planned, receipt = compile_delegation(assignments, 0, proposal(), candidates)
    assert (planned, receipt) == compile_delegation(assignments, 0, proposal(), candidates)
    assert (assignments, candidates) == before
    assert [item["agentId"] for item in planned] == ["a", "b", "a"]
    assert [item["required"] for item in planned] == [False, False, True]
    assert planned[1]["agentInstructions"] == "Test carefully"
    assert planned[2]["delegationReturnId"] == receipt["id"]
    with pytest.raises(ValueError, match="Nested"):
        compile_delegation(planned, 1, proposal(agentId="a"), candidates)
    twice, _ = compile_delegation(planned, 2, proposal(), candidates)
    with pytest.raises(ValueError, match="at most two"):
        compile_delegation(twice, 4, proposal(), candidates)


@pytest.mark.parametrize("target", [None, {"agentId": "b", "daemonNodeId": "other"}, {"agentId": "a", "daemonNodeId": "node"}])
def test_compilation_refuses_unauthorized_or_cross_computer_target(target):
    with pytest.raises(ValueError, match="allowed"):
        compile_delegation([{"assignmentId": "a1", "agentId": "a", "daemonNodeId": "node"}], 0,
                           proposal(), [target] if target else [])


@pytest.mark.parametrize("patch", [{"mode": "ask"}, {"teamSnapshot": {"teamId": "team"}}])
def test_direct_delegation_does_not_replace_team_or_discussion_contracts(patch):
    with pytest.raises(ValueError, match="individual action"):
        compile_delegation([{"assignmentId": "a1", "agentId": "a", **patch}], 0, proposal(), [])
