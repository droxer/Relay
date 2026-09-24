import hashlib
import json
from dataclasses import asdict
from types import SimpleNamespace

from relay.collaboration.models import MessageIntent
from relay.collaboration.service import (
    CollaborationConductor,
    _request_fingerprint,
    _scoped_idempotency_key,
    compile_assignment_work_graph,
    create_round_manifest,
)
from relay.services.team_dispatch import team_member_assignments


def test_addressed_agent_placement_follows_replacement_runtime_on_same_computer() -> (
    None
):
    placement = {
        "id": "placement_1",
        "agentId": "agent_1",
        "daemonNodeId": "runtime_old",
        "computerId": "device:alice:machine-1",
        "desiredState": "active",
    }
    ctx = SimpleNamespace(
        agent_placement_store=SimpleNamespace(
            list_placements=lambda **_kwargs: [placement]
        ),
        agent_store=SimpleNamespace(
            get_agent=lambda _agent_id: {"displayName": "Builder"}
        ),
    )
    conductor = CollaborationConductor(ctx)

    conductor._assert_addressed_agents_on_node(
        [{"agentId": "agent_1"}],
        [],
        "runtime_new",
        [
            {
                "id": "runtime_new",
                "employeeId": "alice",
                "workspaceId": "machine-1",
            }
        ],
    )


def test_round_manifest_names_its_versioned_protocol_contract() -> None:
    manifest = create_round_manifest(
        source="message",
        purpose="discuss",
        address={"kind": "room"},
        assignments=[
            {
                "assignmentId": "assignment_1",
                "agentId": "agent_1",
                "mode": "ask",
                "phase": "discussion",
            }
        ],
        team_snapshot=None,
        collaboration_id="col_1",
        round_id="round_1",
    )

    assert manifest["contract"] == {
        "name": "relay.collaboration.round",
        "version": 2,
    }
    assert manifest["strategy"] == "room"
    assert manifest["completionPolicy"] == "synthesize"
    assert manifest["workGraph"] == {
        "contract": {
            "name": "relay.collaboration.work-graph",
            "version": 1,
        },
        "items": [
            {
                "workItemId": "assignment_1",
                "assignmentId": "assignment_1",
                "ownerAgentId": "agent_1",
                "delegationAuthority": "conductor",
                "kind": "discussion",
                "objective": "Contribute to the team's discussion.",
                "dependsOnWorkItemIds": [],
                "required": True,
            }
        ],
        "completion": {
            "kind": "synthesize",
            "resultOwnerWorkItemId": "assignment_1",
        },
        "delegationPolicy": {
            "authority": "conductor",
            "policy": "sequential-role-delegation-v1",
        },
    }


def test_round_manifest_makes_delegated_subtasks_and_review_dependencies_explicit() -> (
    None
):
    manifest = create_round_manifest(
        source="task",
        purpose="accomplish",
        address={"kind": "room"},
        assignments=[
            {
                "assignmentId": "coordinate",
                "agentId": "lead",
                "mode": "action",
                "phase": "execution",
                "coordinator": True,
                "brief": "Coordinate the delivery.",
            },
            {
                "assignmentId": "implement",
                "agentId": "builder",
                "mode": "action",
                "phase": "execution",
                "role": "implementer",
                "brief": "Implement the change.",
            },
            {
                "assignmentId": "review",
                "agentId": "reviewer",
                "mode": "review",
                "phase": "review",
                "role": "reviewer",
                "brief": "Review the completed change.",
            },
        ],
        team_snapshot={
            "teamId": "team_1",
            "teamRevision": "revision_1",
            "memberAgentIds": ["lead", "builder", "reviewer"],
            "leadAgentId": "lead",
        },
        collaboration_id="col_1",
        round_id="round_1",
    )

    assert manifest["workGraph"]["items"] == [
        {
            "workItemId": "coordinate",
            "assignmentId": "coordinate",
            "ownerAgentId": "lead",
            "delegationAuthority": "conductor",
            "kind": "coordination",
            "objective": "Coordinate the delivery.",
            "dependsOnWorkItemIds": [],
            "required": True,
        },
        {
            "workItemId": "implement",
            "assignmentId": "implement",
            "ownerAgentId": "builder",
            "delegationAuthority": "conductor",
            "kind": "implementation",
            "objective": (
                "Implement the change. Own delegated work item 2 of 3; "
                "use predecessor results and do not duplicate another item."
            ),
            "dependsOnWorkItemIds": ["coordinate"],
            "required": True,
        },
        {
            "workItemId": "review",
            "assignmentId": "review",
            "ownerAgentId": "reviewer",
            "delegationAuthority": "conductor",
            "kind": "review",
            "objective": (
                "Review the completed change. Own delegated work item 3 of 3; "
                "use predecessor results and do not duplicate another item."
            ),
            "dependsOnWorkItemIds": ["coordinate", "implement"],
            "required": True,
        },
    ]
    assert manifest["workGraph"]["completion"] == {
        "kind": "all_required",
        "resultOwnerWorkItemId": "review",
    }


def test_work_graph_keeps_legacy_executor_only_assignments_compatible() -> None:
    manifest = create_round_manifest(
        source="legacy",
        purpose="accomplish",
        address={"kind": "members", "agentIds": []},
        assignments=[
            {
                "assignmentId": "legacy_assignment",
                "agent": "codex",
                "executorKind": "codex",
                "mode": "action",
            }
        ],
        team_snapshot=None,
    )

    assert manifest["workGraph"]["items"][0]["ownerAgentId"] == (
        "legacy-executor:codex"
    )


def test_addressed_lead_discussion_remains_a_discussion_work_item() -> None:
    manifest = create_round_manifest(
        source="message",
        purpose="discuss",
        address={"kind": "members", "agentIds": ["lead"]},
        assignments=[
            {
                "assignmentId": "lead_discussion",
                "agentId": "lead",
                "mode": "ask",
                "phase": "discussion",
                "coordinator": True,
            }
        ],
        team_snapshot={
            "teamId": "team_1",
            "memberAgentIds": ["lead"],
            "leadAgentId": "lead",
        },
    )

    assert manifest["workGraph"]["items"][0]["kind"] == "discussion"


def test_independent_discussion_scope_does_not_claim_predecessors() -> None:
    manifest = create_round_manifest(
        source="message",
        purpose="discuss",
        address={"kind": "room"},
        assignments=[
            {
                "assignmentId": "opinion_1",
                "agentId": "agent_1",
                "mode": "ask",
            },
            {
                "assignmentId": "opinion_2",
                "agentId": "agent_2",
                "mode": "ask",
            },
        ],
        team_snapshot=None,
    )

    second = manifest["workGraph"]["items"][1]
    assert second["dependsOnWorkItemIds"] == []
    assert "independently eligible" in second["objective"]
    assert "predecessor results" not in second["objective"]


def test_assignment_phase_is_derived_instead_of_trusting_legacy_input() -> None:
    [assignment] = CollaborationConductor._compile_assignments(
        [
            {
                "agentId": "lead",
                "mode": "action",
                "role": "reviewer",
                "phase": "review",
            }
        ],
        "team_1",
        {"lead"},
        {
            "teamId": "team_1",
            "memberAgentIds": ["lead"],
            "leadAgentId": "lead",
        },
    )

    assert assignment["phase"] == "execution"


def test_message_id_is_the_default_idempotency_key() -> None:
    prepared = CollaborationConductor._prepare(
        MessageIntent(
            thread_id="thread_1",
            text="continue",
            user_message_id="message_1",
        )
    )

    assert prepared.idempotency_key == "message_1"


def test_idempotency_scope_separates_actors_and_threads() -> None:
    assert _scoped_idempotency_key("alice", "thread_1", "retry_1") != (
        _scoped_idempotency_key("bob", "thread_1", "retry_1")
    )
    assert _scoped_idempotency_key("alice", "thread_1", "retry_1") != (
        _scoped_idempotency_key("alice", "thread_2", "retry_1")
    )


def test_request_fingerprint_rejects_reusing_a_key_for_different_intent() -> None:
    first = CollaborationConductor._prepare(
        MessageIntent(
            thread_id="thread_1",
            text="first request",
            idempotency_key="retry_1",
        )
    )
    second = CollaborationConductor._prepare(
        MessageIntent(
            thread_id="thread_1",
            text="different request",
            idempotency_key="retry_1",
        )
    )

    assert _request_fingerprint(first) != _request_fingerprint(second)


def test_team_discussion_survives_assignment_compilation() -> None:
    """A discuss round must reach the agents as a discussion, not as action work.

    `team_member_assignments` and `_compile_assignments` meet here; a mode
    dropped at that seam silently turns a question into workspace work.
    """
    team = {
        "id": "team_1",
        "leadAgentId": "lead",
        "memberAgentIds": ["lead", "support"],
        "updatedAt": "2026-08-08T00:00:00Z",
    }
    agents = [
        {"id": "lead", "executorKind": "codex", "defaultRole": "planner"},
        {"id": "support", "executorKind": "claude", "defaultRole": "reviewer"},
    ]
    raw = team_member_assignments(agents, mode="ask", team=team)

    compiled = CollaborationConductor._compile_assignments(
        raw, "team_1", {"lead", "support"}, raw[0]["teamSnapshot"]
    )

    assert [item["mode"] for item in compiled] == ["ask", "ask"]
    assert [item["phase"] for item in compiled] == ["discussion", "discussion"]


def test_compiling_an_already_compiled_round_changes_nothing() -> None:
    """The conductor compiles, then `create_round_manifest` compiles again.

    That second pass must stay a no-op: re-decorating an objective would
    restate the work-item preamble every time the manifest is built.
    """
    assignments = [
        {"assignmentId": "a1", "agentId": "lead", "mode": "action"},
        {"assignmentId": "a2", "agentId": "support", "mode": "action"},
    ]
    once = compile_assignment_work_graph(
        assignments, purpose="accomplish", team_snapshot=None
    )

    assert (
        compile_assignment_work_graph(
            once, purpose="accomplish", team_snapshot=None
        )
        == once
    )


def test_partial_work_graph_metadata_is_completed_before_manifest_creation() -> None:
    """A legacy workItemId alone is not a complete versioned work graph."""
    manifest = create_round_manifest(
        source="legacy",
        purpose="accomplish",
        address={"kind": "members", "agentIds": ["agent_1"]},
        assignments=[
            {
                "assignmentId": "assignment_1",
                "agentId": "agent_1",
                "workItemId": "legacy_item",
            }
        ],
        team_snapshot=None,
    )

    assert manifest["workGraph"]["items"] == [
        {
            "workItemId": "assignment_1",
            "assignmentId": "assignment_1",
            "ownerAgentId": "agent_1",
            "delegationAuthority": "conductor",
            "kind": "implementation",
            "objective": "Implement a distinct part of the shared goal.",
            "dependsOnWorkItemIds": [],
            "required": True,
        }
    ]


def _styled_manifest(style: str, **snapshot_extra):
    roster = [
        {"id": "lead", "executorKind": "codex", "defaultRole": "planner"},
        {"id": "dev", "executorKind": "codex", "defaultRole": "implementer"},
        {"id": "qa", "executorKind": "claude", "defaultRole": "reviewer"},
    ]
    team = {"id": "team_1", "leadAgentId": "lead", "memberAgentIds": ["lead", "dev", "qa"], "memberConfigs": {}}
    assignments = [
        {**item, "assignmentId": f"a{index}"}
        for index, item in enumerate(team_member_assignments(roster, team=team, style=style))
    ]
    snapshot = {**assignments[0]["teamSnapshot"], **snapshot_extra}
    return create_round_manifest(
        source="message", purpose="accomplish", address={"kind": "room"},
        assignments=compile_assignment_work_graph(assignments, purpose="accomplish", team_snapshot=snapshot),
        team_snapshot=snapshot,
    )


def test_manifest_records_the_style_and_its_policy() -> None:
    manifest = _styled_manifest("build_review")
    assert manifest["style"] == "build_review"
    assert manifest["workGraph"]["delegationPolicy"]["policy"] == "build-review-v1"
    assert [item["kind"] for item in manifest["workGraph"]["items"]] == ["implementation", "synthesis"]


def test_manifest_records_a_fallback() -> None:
    manifest = _styled_manifest("solo", styleFallbackFrom="build_review")
    assert manifest["style"] == "solo"
    assert manifest["styleFallbackFrom"] == "build_review"
    assert manifest["workGraph"]["delegationPolicy"]["policy"] == "solo-v1"


def test_lead_led_manifest_keeps_its_policy() -> None:
    manifest = _styled_manifest("lead_led")
    assert manifest["style"] == "lead_led"
    assert manifest["workGraph"]["delegationPolicy"]["policy"] == "sequential-role-delegation-v1"


def test_manifest_without_a_team_has_no_style() -> None:
    manifest = create_round_manifest(
        source="message", purpose="accomplish", address={"kind": "room"},
        assignments=[{"assignmentId": "a", "agentId": "x", "mode": "action"}], team_snapshot=None,
    )
    assert "style" not in manifest


def test_lead_is_coordinator_only_in_lead_led_rounds() -> None:
    conductor = CollaborationConductor(SimpleNamespace())
    for style, expected in (("lead_led", True), ("build_review", False), ("pipeline", False)):
        snapshot = {"teamId": "t", "leadAgentId": "lead", "collaborationStyle": style}
        [compiled] = conductor._compile_assignments(
            [{"agentId": "lead", "mode": "action", "role": "implementer"}], "t", {"lead"}, snapshot
        )
        assert bool(compiled.get("coordinator")) is expected, style
    legacy = {"teamId": "t", "leadAgentId": "lead"}
    [compiled] = conductor._compile_assignments([{"agentId": "lead", "mode": "action"}], "t", {"lead"}, legacy)
    assert compiled["coordinator"] is True


def test_fingerprint_without_style_matches_the_pre_style_shape() -> None:
    plain = CollaborationConductor._prepare(MessageIntent(thread_id="t", text="hi"))
    styled = CollaborationConductor._prepare(MessageIntent(thread_id="t", text="hi", style="solo"))
    assert plain.style is None
    assert _request_fingerprint(plain) != _request_fingerprint(styled)
    legacy_payload = {k: v for k, v in asdict(plain).items() if k not in ("idempotency_key", "style")}
    legacy = hashlib.sha256(
        json.dumps(legacy_payload, sort_keys=True, separators=(",", ":"), ensure_ascii=True).encode()
    ).hexdigest()
    assert _request_fingerprint(plain) == legacy
