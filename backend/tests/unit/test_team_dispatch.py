from __future__ import annotations

from typing import Any

import pytest

from relay.services.team_dispatch import (
    TeamDispatchError,
    team_agents,
    team_member_assignments,
)


class FakeTeamStore:
    def __init__(self, team: dict[str, Any] | None) -> None:
        self._team = team

    def get_team(self, team_id: str) -> dict[str, Any] | None:
        if self._team and self._team["id"] == team_id:
            return self._team
        return None


class FakeAgentStore:
    def __init__(self, agents: list[dict[str, Any]]) -> None:
        self._agents = {agent["id"]: agent for agent in agents}

    def get_agent(self, agent_id: str) -> dict[str, Any] | None:
        return self._agents.get(agent_id)


def _agent(agent_id: str, executor: str, **overrides: Any) -> dict[str, Any]:
    return {
        "id": agent_id,
        "executorKind": executor,
        "displayName": agent_id.title(),
        "enabled": True,
        "version": 1,
        **overrides,
    }


def _team(style: str | None = None, **overrides: Any) -> dict[str, Any]:
    return {
        "id": "team_1",
        "ownerEmployeeId": "alice",
        "leadAgentId": "lead",
        "memberAgentIds": ["support", "lead"],
        "memberConfigs": {},
        "acceptanceCriteria": ["Tests pass"],
        "enabled": True,
        **({"collaborationStyle": style} if style else {}),
        **overrides,
    }


def test_team_role_overrides_global_default_and_scopes_work() -> None:
    team = _team(memberConfigs={"support": {
        "role": "implementer", "responsibility": "Own the API and its tests", "required": True,
    }}, acceptanceCriteria=["API compatibility"])
    agents = [_agent("lead", "codex"), _agent("support", "claude", defaultRole="reviewer")]
    assignments = team_member_assignments(agents, team=team)
    support = next(item for item in assignments if item["agentId"] == "support")
    assert support["role"] == "implementer"
    assert "Own the API and its tests" in support["brief"]
    assert support["acceptanceCriteria"] == ["API compatibility"]
    assert assignments[-1]["agentId"] == "lead"
    assert assignments[-1]["synthesizer"] is True


def test_on_request_specialist_is_not_automatically_activated() -> None:
    team = _team(memberConfigs={"support": {"participation": "on_request", "required": False}})
    assignments = team_member_assignments([_agent("lead", "codex"), _agent("support", "claude")], team=team)
    assert [item["agentId"] for item in assignments] == ["lead"]


def test_disabled_on_request_specialist_does_not_block_the_active_team():
    team, agents = team_agents("team_1", "alice",
        team_store=FakeTeamStore(_team(memberConfigs={"support": {"participation": "on_request", "required": False}})),
        agent_store=FakeAgentStore([_agent("lead", "codex"), _agent("support", "claude", enabled=False)]))
    assert [item["agentId"] for item in team_member_assignments(agents, team=team)] == ["lead"]


def test_team_agents_returns_the_lead_first() -> None:
    team, agents = team_agents(
        "team_1",
        "alice",
        team_store=FakeTeamStore(_team()),
        agent_store=FakeAgentStore(
            [_agent("lead", "codex"), _agent("support", "claude")]
        ),
    )

    assert team["id"] == "team_1"
    assert [agent["id"] for agent in agents] == ["lead", "support"]


@pytest.mark.parametrize(
    ("team", "agents", "code"),
    [
        (None, [], "team_not_found"),
        (_team(deletedAt="2026-01-01T00:00:00Z"), [], "team_not_found"),
        (_team(enabled=False), [], "team_disabled"),
        (_team(ownerEmployeeId="bob"), [], "team_forbidden"),
        (_team(leadAgentId="stranger"), [], "team_invalid"),
    ],
)
def test_team_agents_refuses_an_unusable_team(
    team: dict[str, Any] | None, agents: list[dict[str, Any]], code: str
) -> None:
    with pytest.raises(TeamDispatchError) as error:
        team_agents(
            "team_1",
            "alice",
            team_store=FakeTeamStore(team),
            agent_store=FakeAgentStore(
                agents or [_agent("lead", "codex"), _agent("support", "claude")]
            ),
        )

    assert error.value.code == code
    assert error.value.permanent is True


def test_team_member_assignments_sends_a_reviewer_to_review() -> None:
    agents = [
        _agent("lead", "codex"),
        _agent("support", "claude", defaultRole="reviewer"),
    ]
    assert team_member_assignments(agents) == [
        {
            "agentId": "lead",
            "agent": "codex",
            "mode": "action",
            "phase": "execution",
            "coordinator": True,
            "brief": (
                "Coordinate the round, establish clear boundaries, and keep the "
                "shared work coherent."
            ),
        },
        {
            "agentId": "support",
            "agent": "claude",
            "mode": "action",
            "phase": "review",
            "role": "reviewer",
            "brief": (
                "Review the accumulated workspace changes and synthesize "
                "blocking issues and missing tests."
            ),
        },
    ]


def test_team_member_assignments_freezes_the_roster_for_the_round() -> None:
    team = _team(updatedAt="2026-08-08T00:00:00Z")
    agents = [_agent("lead", "codex"), _agent("support", "claude")]

    assignments = team_member_assignments(agents, team=team)

    expected = {
        "teamId": "team_1",
        "teamRevision": "2026-08-08T00:00:00Z",
        "workContractVersion": 1,
        "memberAgentIds": ["lead", "support"],
        "leadAgentId": "lead",
        "collaborationStyle": "lead_led",
    }
    assert [item["teamSnapshot"] for item in assignments] == [expected, expected, expected]


def test_discussion_runs_the_facilitator_last_without_changing_the_snapshot() -> None:
    team = _team(updatedAt="2026-08-08T00:00:00Z")
    agents = [_agent("lead", "codex"), _agent("support", "claude")]

    assignments = team_member_assignments(agents, mode="ask", team=team)

    assert [item["agentId"] for item in assignments] == ["support", "lead"]
    assert [item.get("coordinator", False) for item in assignments] == [False, True]
    assert [item["teamSnapshot"]["memberAgentIds"] for item in assignments] == [
        ["lead", "support"],
        ["lead", "support"],
    ]
    assert assignments[-1]["synthesizer"] is True
    assert assignments[-1]["brief"].startswith("Synthesize")


def test_review_runs_the_facilitator_last_as_the_result_synthesizer() -> None:
    team = _team(updatedAt="2026-08-08T00:00:00Z")
    agents = [
        _agent("lead", "codex", defaultRole="planner"),
        _agent("support", "claude", defaultRole="reviewer"),
    ]

    assignments = team_member_assignments(agents, mode="review", team=team)

    assert [item["agentId"] for item in assignments] == ["support", "lead"]
    assert assignments[-1]["synthesizer"] is True
    assert assignments[-1]["brief"].startswith("Synthesize")


def test_accomplish_orders_delegated_execution_before_test_and_review() -> None:
    team = _team(
        memberAgentIds=["lead", "reviewer", "tester", "builder"],
        updatedAt="2026-08-08T00:00:00Z",
    )
    agents = [
        _agent("lead", "codex", defaultRole="planner"),
        _agent("reviewer", "claude", defaultRole="reviewer"),
        _agent("tester", "pi", defaultRole="tester"),
        _agent("builder", "kimi", defaultRole="implementer"),
    ]

    assignments = team_member_assignments(agents, mode="action", team=team)

    assert [item["agentId"] for item in assignments] == [
        "lead",
        "builder",
        "tester",
        "reviewer",
        "lead",
    ]


def test_accomplish_keeps_a_reviewer_lead_in_writable_coordination_mode() -> None:
    team = _team(updatedAt="2026-08-08T00:00:00Z")
    agents = [
        _agent("lead", "codex", defaultRole="reviewer"),
        _agent("support", "claude", defaultRole="implementer"),
    ]

    assignments = team_member_assignments(agents, mode="action", team=team)

    assert assignments[0]["agentId"] == "lead"
    assert assignments[0]["phase"] == "execution"
    assert assignments[0]["brief"].startswith("Coordinate the round")


def test_team_member_assignments_carry_the_round_mode() -> None:
    team = _team(updatedAt="2026-08-08T00:00:00Z")
    agents = [_agent("lead", "codex"), _agent("support", "claude")]

    for mode in ("action", "ask", "review"):
        assignments = team_member_assignments(agents, mode=mode, team=team)
        assert all(item["mode"] == mode for item in assignments), mode


@pytest.mark.parametrize("role", [None, "planner", "implementer", "fixer", "tester", "reviewer"])
def test_regular_team_members_are_required_by_default(role):
    assignments = team_member_assignments(
        [_agent("lead", "codex"), _agent("support", "claude", defaultRole=role)],
        team=_team(),
    )
    assert all(item["required"] for item in assignments)
    assert all(item["teamSnapshot"]["workContractVersion"] == 1 for item in assignments)


def test_explicit_optional_contribution_is_preserved():
    assignments = team_member_assignments(
        [_agent("lead", "codex"), _agent("support", "claude")],
        team=_team(memberConfigs={"support": {"required": False}}),
    )
    assert assignments[1]["required"] is False


def test_lead_final_turn_reviews_before_delivering_result():
    assignments = team_member_assignments(
        [_agent("lead", "codex"), _agent("support", "claude")], team=_team(),
    )
    assert "Review" in assignments[-1]["brief"]
    assert "acceptance criteria" in assignments[-1]["brief"]


def _roster() -> list[dict[str, Any]]:
    return [
        _agent("lead", "codex", defaultRole="planner"),
        _agent("dev", "codex", defaultRole="implementer"),
        _agent("qa", "claude", defaultRole="reviewer"),
    ]


def _shape(assignments: list[dict[str, Any]]) -> list[tuple]:
    return [
        (a["agentId"], a.get("role"), a["mode"], bool(a.get("coordinator")), bool(a.get("synthesizer")), a.get("required"))
        for a in assignments
    ]


def test_build_review_runs_builder_then_reviewer_with_no_coordinator() -> None:
    assignments = team_member_assignments(_roster(), team=_team(), style="build_review")
    assert _shape(assignments) == [
        ("dev", "implementer", "action", False, False, True),
        ("qa", "reviewer", "review", False, True, True),
    ]
    snapshot = assignments[0]["teamSnapshot"]
    assert snapshot["collaborationStyle"] == "build_review"
    assert snapshot["workContractVersion"] == 1
    assert "styleFallbackFrom" not in snapshot
    assert all(a["acceptanceCriteria"] == ["Tests pass"] for a in assignments)


def test_solo_runs_only_the_builder_as_its_own_synthesizer() -> None:
    assignments = team_member_assignments(_roster(), team=_team(), style="solo")
    assert _shape(assignments) == [("dev", "implementer", "action", False, True, True)]
    assert assignments[0]["teamSnapshot"]["collaborationStyle"] == "solo"


def test_pipeline_runs_members_in_role_order_and_last_synthesizes() -> None:
    assignments = team_member_assignments(_roster(), team=_team(), style="pipeline")
    assert _shape(assignments) == [
        ("lead", "planner", "action", False, False, True),
        ("dev", "implementer", "action", False, False, True),
        ("qa", "reviewer", "action", False, True, True),
    ]


def test_one_member_build_review_falls_back_to_solo_and_records_it() -> None:
    team = _team(memberAgentIds=["lead"])
    assignments = team_member_assignments(
        [_agent("lead", "codex", defaultRole="reviewer")], team=team, style="build_review"
    )
    assert _shape(assignments) == [("lead", "implementer", "action", False, True, True)]
    snapshot = assignments[0]["teamSnapshot"]
    assert snapshot["collaborationStyle"] == "solo"
    assert snapshot["styleFallbackFrom"] == "build_review"


def test_removing_the_only_reviewer_falls_back_instead_of_failing() -> None:
    roster = [_agent("lead", "codex", defaultRole="implementer")]
    team = _team(memberAgentIds=["lead"], collaborationStyle="build_review")
    assignments = team_member_assignments(roster, team=team, style="build_review")
    assert len(assignments) == 1
    assert assignments[0]["teamSnapshot"]["styleFallbackFrom"] == "build_review"


def test_membership_role_override_decides_the_slot() -> None:
    team = _team(memberConfigs={"lead": {"role": "implementer"}, "dev": {"role": "tester"}})
    assignments = team_member_assignments(_roster(), team=team, style="build_review")
    assert [a["agentId"] for a in assignments] == ["lead", "qa"]


def test_on_request_members_never_fill_a_slot() -> None:
    team = _team(memberConfigs={"qa": {"participation": "on_request"}})
    assignments = team_member_assignments(_roster(), team=team, style="build_review")
    assert [a["agentId"] for a in assignments] == ["dev", "lead"]


def test_non_action_rounds_ignore_the_style() -> None:
    discuss = team_member_assignments(_roster(), mode="ask", team=_team(), style="build_review")
    assert [a["agentId"] for a in discuss][-1] == "lead"
    assert all("collaborationStyle" not in (a.get("teamSnapshot") or {}) for a in discuss)


def test_lead_led_output_is_unchanged_apart_from_the_recorded_style() -> None:
    default = team_member_assignments(_roster(), team=_team())
    explicit = team_member_assignments(_roster(), team=_team(), style="lead_led")
    assert explicit == default
    assert [a["agentId"] for a in default] == ["lead", "dev", "qa", "lead"]
    assert default[0]["coordinator"] is True and default[-1]["synthesizer"] is True
    assert default[0]["teamSnapshot"]["collaborationStyle"] == "lead_led"


def test_style_builders_do_not_mutate_the_roster() -> None:
    roster = _roster()
    before = [dict(agent) for agent in roster]
    for style in ("solo", "build_review", "pipeline", "lead_led"):
        team_member_assignments(roster, team=_team(), style=style)
    assert roster == before
