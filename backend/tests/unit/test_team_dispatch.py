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


def _team(**overrides: Any) -> dict[str, Any]:
    return {
        "id": "team_1",
        "ownerEmployeeId": "alice",
        "leadAgentId": "lead",
        "memberAgentIds": ["support", "lead"],
        "enabled": True,
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
        "memberAgentIds": ["lead", "support"],
        "leadAgentId": "lead",
    }
    assert [item["teamSnapshot"] for item in assignments] == [expected, expected]


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
        assert [item["mode"] for item in assignments] == [mode, mode], mode
