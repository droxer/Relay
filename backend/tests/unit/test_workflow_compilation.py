"""Workflow execution compilation is separate from legacy role templates."""
from copy import deepcopy

import pytest

from relay.collaboration.workflow_compilation import compile_workflow, retry_workflow_assignment


def definition():
    return {
        "id": "team-1", "ownerUserId": "owner", "projectId": "project-1",
        "computerId": "computer-1", "leadAgentId": "builder",
        "memberAgentIds": ["builder", "reviewer"],
        "workflowSteps": [
            {"id": "review-first", "name": "Review design", "agentId": "reviewer",
             "instructions": "Review before building", "expectedOutputs": ["review notes"],
             "acceptanceCriteria": ["Risks documented"], "requiresApproval": True},
            {"id": "build", "name": "Build", "agentId": "builder",
             "instructions": "Implement reviewed design", "expectedOutputs": ["implementation"],
             "acceptanceCriteria": ["Tests pass"]},
            {"id": "deploy", "name": "Deploy", "agentId": "reviewer", "kind": "deployment",
             "instructions": "Deploy verified changes", "expectedOutputs": ["deployment record"],
             "acceptanceCriteria": ["Health check passes"]},
        ],
    }


def roster():
    return [
        {"agentId": "builder", "executorKind": "codex", "role": "implementer", "daemonNodeId": "node"},
        {"agentId": "reviewer", "executorKind": "claude", "role": "reviewer", "daemonNodeId": "node"},
    ]


def compile_run(team=None, members=None, run_id="run-1"):
    return compile_workflow(team or definition(), roster() if members is None else members, run_id=run_id)


def test_saved_order_repeated_assignees_and_no_synthesis_turn():
    assignments = compile_run()
    assert [a["agentId"] for a in assignments] == ["reviewer", "builder", "reviewer"]
    assert [a["workflowStepId"] for a in assignments] == ["review-first", "build", "deploy"]
    assert len({a["assignmentId"] for a in assignments}) == 3
    assert all(a["required"] and not a["coordinator"] and not a["synthesizer"] for a in assignments)
    assert [a["awaitApproval"] for a in assignments] == [True, False, True]
    assert assignments[0]["dependsOnWorkItemIds"] == []
    assert assignments[2]["dependsOnWorkItemIds"] == [a["workItemId"] for a in assignments[:2]]


def test_contract_and_transport_are_preserved_without_role_reordering():
    assignments = compile_run()
    for step, assignment in zip(definition()["workflowSteps"], assignments, strict=True):
        assert assignment["brief"] == step["instructions"]
        assert assignment["workObjective"] == step["instructions"]
        assert assignment["expectedOutputs"] == step["expectedOutputs"]
        assert assignment["acceptanceCriteria"] == step["acceptanceCriteria"]
        assert assignment["daemonNodeId"] == "node"
        assert assignment["mode"] == "action"
        assert assignment["workOwnerAgentId"] == step["agentId"]
        assert assignment["delegationAuthority"] == "conductor"


def test_snapshot_is_deeply_detached_from_definition_roster_and_other_steps():
    team, members = definition(), roster()
    assignments = compile_run(team, members)
    original = deepcopy(assignments)
    team["workflowSteps"].reverse()
    team["workflowSteps"][0]["expectedOutputs"].append("changed")
    members[0]["executorKind"] = "pi"
    assert assignments == original
    assignments[0]["teamSnapshot"]["workflowSteps"][0]["expectedOutputs"].append("mutated")
    assert assignments[1:] == original[1:]
    assert assignments[0]["expectedOutputs"] == ["review notes"]


def test_same_run_recompiles_identically_and_different_runs_have_distinct_identity():
    first = compile_run()
    assert first == compile_run()
    second = compile_run(run_id="run-2")
    assert {a["assignmentId"] for a in first}.isdisjoint(a["assignmentId"] for a in second)
    assert {a["workItemId"] for a in first}.isdisjoint(a["workItemId"] for a in second)
    assert all(a["assignmentId"] != a["workItemId"] for a in first)


def test_retry_changes_only_attempt_identity_and_preserves_step_and_dependencies():
    current = compile_run()[2]
    retried = retry_workflow_assignment(current)
    assert current["workflowAttempt"] == 1
    assert retried["workflowAttempt"] == 2
    assert retried["assignmentId"] != current["assignmentId"]
    assert retried["workItemId"] == current["workItemId"]
    assert retried["workflowStepId"] == "deploy"
    assert retried["dependsOnWorkItemIds"] == current["dependsOnWorkItemIds"]
    assert retried["awaitApproval"] is True
    assert retry_workflow_assignment(current) == retried
    assert retry_workflow_assignment(retried)["workflowAttempt"] == 3
    retried["expectedOutputs"].append("new")
    assert current["expectedOutputs"] == ["deployment record"]


@pytest.mark.parametrize("members", [[], roster()[:1], [*roster(), roster()[0]]])
def test_missing_or_ambiguous_assignee_never_falls_back(members):
    with pytest.raises(ValueError, match="workflow_roster"):
        compile_run(members=members)


@pytest.mark.parametrize("run_id", ["", " ", None, 5, "x" * 201])
def test_invalid_run_identity_refused(run_id):
    with pytest.raises(ValueError, match="workflow_run_id"):
        compile_run(run_id=run_id)


def test_malformed_definition_refused_instead_of_legacy_fallback():
    team = definition()
    team["workflowSteps"] = []
    with pytest.raises(ValueError):
        compile_run(team)


def test_legacy_team_refused_by_workflow_compiler():
    with pytest.raises(ValueError, match="workflow_definition_required"):
        compile_run({"id": "legacy"})


@pytest.mark.parametrize("attempt", [0, -1, True, "1", None])
def test_invalid_retry_attempt_refused(attempt):
    assignment = compile_run()[0]
    assignment["workflowAttempt"] = attempt
    with pytest.raises(ValueError, match="workflow_attempt"):
        retry_workflow_assignment(assignment)


def test_legacy_authority_cannot_leak_from_resolved_roster():
    members = roster()
    members[0].update(coordinator=True, synthesizer=True, workKind="coordination",
                      required=False, awaitApproval=True, workItemId="old", assignmentId="old",
                      delegatedByAgentId="lead", brief="Plan the team", mode="ask")
    result = compile_run(members=members)[1]
    assert not result["coordinator"] and not result["synthesizer"]
    assert result["required"] and not result["awaitApproval"]
    assert result["mode"] == "action"
    assert result["workKind"] == "workflow_step"
    assert "delegatedByAgentId" not in result
    assert result["workItemId"] != "old"


@pytest.mark.parametrize("field,value", [
    ("workflowStepId", "different"), ("assignmentId", "foreign-attempt"),
    ("workItemId", "foreign-step"), ("workflowRunId", "another-run"),
])
def test_retry_refuses_mixed_identity(field, value):
    assignment = compile_run()[0]
    assignment[field] = value
    with pytest.raises(ValueError, match="workflow_attempt"):
        retry_workflow_assignment(assignment)


def test_definition_edits_only_change_later_compilation():
    team = definition()
    first = compile_run(team)
    team["workflowSteps"].reverse()
    second = compile_run(team, run_id="later-run")
    assert [a["workflowStepId"] for a in first] == ["review-first", "build", "deploy"]
    assert [a["workflowStepId"] for a in second] == ["deploy", "build", "review-first"]
    assert first[0]["teamSnapshot"]["workflowSteps"][0]["id"] == "review-first"


def test_json_round_trip_preserves_retry_identity():
    import json

    original = compile_run()
    restored = json.loads(json.dumps(original))
    assert retry_workflow_assignment(restored[0]) == retry_workflow_assignment(original[0])


def manifest_for(assignments, team=None, purpose="accomplish"):
    from relay.collaboration.manifest import create_round_manifest

    return create_round_manifest(
        source="task", purpose=purpose, address={"kind": "room"},
        assignments=assignments, team_snapshot=team or assignments[0]["teamSnapshot"],
        collaboration_id="collaboration", round_id="round",
    )


def test_manifest_keeps_workflow_contract_and_attempt_bound_gate():
    assignments = compile_run()
    assignments[0] = retry_workflow_assignment(assignments[0])
    original = deepcopy(assignments)
    manifest = manifest_for(assignments)
    assert assignments == original
    assert manifest["strategy"] == "coordinate"
    assert manifest["workGraph"]["delegationPolicy"]["policy"] == "project-workflow-v1"
    for item, turn, expected in zip(
        manifest["workGraph"]["items"], manifest["assignments"], assignments, strict=True,
    ):
        assert item["workItemId"] == expected["workItemId"]
        assert item["assignmentId"] == expected["assignmentId"]
        assert item["kind"] == "workflow_step"
        assert item["dependsOnWorkItemIds"] == expected["dependsOnWorkItemIds"]
        for key in ("workflowRunId", "workflowStepId", "workflowAttempt", "awaitApproval"):
            assert turn[key] == expected[key]
            assert item[key] == expected[key]
    assert manifest["workGraph"]["completion"] == {
        "kind": "all_required", "resultOwnerWorkItemId": assignments[-1]["workItemId"],
    }


def test_workflow_work_graph_double_compilation_is_idempotent_and_detached():
    from relay.collaboration.manifest import compile_assignment_work_graph

    assignments = compile_run()
    snapshot = assignments[0]["teamSnapshot"]
    compiled = compile_assignment_work_graph(assignments, purpose="accomplish", team_snapshot=snapshot)
    assert compiled == assignments
    assert compile_assignment_work_graph(compiled, purpose="accomplish", team_snapshot=snapshot) == compiled
    compiled[0]["teamSnapshot"]["workflowSteps"][0]["expectedOutputs"].append("changed")
    assert assignments[0]["teamSnapshot"]["workflowSteps"][0]["expectedOutputs"] == ["review notes"]


@pytest.mark.parametrize("mutation", [
    "reorder", "missing", "duplicate", "foreign_run", "foreign_snapshot",
    "legacy", "gate", "objective", "owner", "dependencies", "attempt", "authority",
])
def test_manifest_rejects_inconsistent_workflow_contract(mutation):
    assignments = compile_run()
    snapshot = deepcopy(assignments[0]["teamSnapshot"])
    if mutation == "reorder":
        assignments.reverse()
    elif mutation == "missing":
        assignments.pop()
    elif mutation == "duplicate":
        assignments[1] = deepcopy(assignments[0])
    elif mutation == "foreign_run":
        assignments[1] = compile_run(run_id="other")[1]
    elif mutation == "foreign_snapshot":
        assignments[1]["teamSnapshot"]["workflowSteps"][0]["instructions"] = "changed"
    elif mutation == "legacy":
        del assignments[1]["workflowStepId"]
    elif mutation == "gate":
        assignments[0]["awaitApproval"] = False
    elif mutation == "objective":
        assignments[1]["brief"] = "changed"
    elif mutation == "owner":
        assignments[1]["agentId"] = "reviewer"
    elif mutation == "dependencies":
        assignments[1]["dependsOnWorkItemIds"] = []
    elif mutation == "attempt":
        assignments[1]["workflowAttempt"] = 2
    elif mutation == "authority":
        assignments[1]["coordinator"] = True
    with pytest.raises(ValueError, match="workflow"):
        manifest_for(assignments, team=snapshot)


@pytest.mark.parametrize("purpose", ["discuss", "review"])
def test_workflow_cannot_be_reinterpreted_as_legacy_discussion(purpose):
    with pytest.raises(ValueError, match="workflow"):
        manifest_for(compile_run(), purpose=purpose)


def test_workflow_assignments_cannot_fall_back_without_workflow_snapshot():
    with pytest.raises(ValueError, match="workflow"):
        manifest_for(compile_run(), team={"id": "legacy"})


def test_empty_workflow_graph_refused():
    from relay.collaboration.manifest import compile_assignment_work_graph

    with pytest.raises(ValueError, match="workflow"):
        compile_assignment_work_graph([], purpose="accomplish", team_snapshot=definition())


@pytest.mark.parametrize("field,value", [("awaitApproval", 1), ("required", 1)])
def test_workflow_contract_requires_real_boolean_flags(field, value):
    assignments = compile_run()
    assignments[0][field] = value
    with pytest.raises(ValueError, match="workflow"):
        manifest_for(assignments)


def test_legacy_approval_manifest_shape_unchanged():
    from relay.collaboration.manifest import create_round_manifest

    manifest = create_round_manifest(
        source="task", purpose="accomplish", address={"kind": "room"},
        assignments=[{"assignmentId": "old", "agentId": "builder", "awaitApproval": True}],
        team_snapshot={"humanApproval": True},
    )
    assert "awaitApproval" not in manifest["assignments"][0]
    assert "awaitApproval" not in manifest["workGraph"]["items"][0]


def test_workflow_marker_removal_does_not_enable_legacy_fallback():
    assignments = compile_run()
    for assignment in assignments:
        del assignment["workflowRunId"]
        del assignment["workflowStepId"]
    with pytest.raises(ValueError, match="workflow"):
        manifest_for(assignments, team={"id": "legacy"})
