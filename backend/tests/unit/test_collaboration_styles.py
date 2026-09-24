from __future__ import annotations

import pytest

from relay.collaboration.styles import (
    COLLABORATION_STYLES,
    CollaborationStyleError,
    fill_build_review_slots,
    pipeline_order,
    resolve_collaboration_style,
    validate_collaboration_style,
)


def _agent(agent_id: str, role: str | None = None) -> dict:
    return {"id": agent_id, "executorKind": "codex", **({"defaultRole": role} if role else {})}


def test_team_styles_exclude_solo() -> None:
    assert COLLABORATION_STYLES == ("build_review", "pipeline", "lead_led")
    with pytest.raises(CollaborationStyleError):
        validate_collaboration_style("solo")
    with pytest.raises(CollaborationStyleError):
        resolve_collaboration_style(None, None, "solo")


def test_legacy_solo_settings_use_build_review_for_new_rounds() -> None:
    assert resolve_collaboration_style({"collaborationStyle": "solo"}, None, None) == "build_review"
    assert resolve_collaboration_style(None, {"collaborationStyle": "solo"}, None) == "build_review"


@pytest.mark.parametrize(
    ("team", "task", "requested", "expected"),
    [
        (None, None, None, "build_review"),
        ({"collaborationStyle": "pipeline"}, None, None, "pipeline"),
        ({"collaborationStyle": "pipeline"}, {"collaborationStyle": "build_review"}, None, "build_review"),
        ({"collaborationStyle": "pipeline"}, {"collaborationStyle": "solo"}, "lead_led", "lead_led"),
        ({"collaborationStyle": "pipeline"}, {"collaborationStyle": None}, None, "pipeline"),
        ({}, {}, None, "build_review"),
    ],
)
def test_message_beats_task_beats_team_beats_default(team, task, requested, expected) -> None:
    assert resolve_collaboration_style(team, task, requested) == expected


@pytest.mark.parametrize("value", ["", "Lead-Led", "discussion", 3, None])
def test_invalid_style_is_rejected_with_the_allowed_list(value) -> None:
    with pytest.raises(CollaborationStyleError, match="must be one of: build_review, pipeline, lead_led"):
        validate_collaboration_style(value)


def test_invalid_stored_style_fails_resolution() -> None:
    with pytest.raises(CollaborationStyleError):
        resolve_collaboration_style({"collaborationStyle": "debate"}, None, None)


def test_implementer_lead_builds_and_reviewer_reviews() -> None:
    agents = [_agent("lead", "implementer"), _agent("qa", "reviewer"), _agent("dev", "implementer")]
    slots = fill_build_review_slots(agents, "lead")
    assert (slots.builder["id"], slots.reviewer["id"]) == ("lead", "qa")


def test_lead_with_reviewer_role_reviews_while_implementer_builds() -> None:
    agents = [_agent("lead", "reviewer"), _agent("dev", "implementer")]
    slots = fill_build_review_slots(agents, "lead")
    assert (slots.builder["id"], slots.reviewer["id"]) == ("dev", "lead")


def test_fixer_can_build_and_tester_reviews_when_no_reviewer() -> None:
    agents = [_agent("lead", "planner"), _agent("fix", "fixer"), _agent("test", "tester")]
    slots = fill_build_review_slots(agents, "lead")
    assert (slots.builder["id"], slots.reviewer["id"]) == ("fix", "test")


def test_no_builder_role_means_lead_builds_and_first_other_reviews() -> None:
    agents = [_agent("lead", "planner"), _agent("p2", "planner")]
    slots = fill_build_review_slots(agents, "lead")
    assert (slots.builder["id"], slots.reviewer["id"]) == ("lead", "p2")


def test_reviewer_is_never_the_builder() -> None:
    agents = [_agent("lead", "implementer"), _agent("other", "implementer")]
    slots = fill_build_review_slots(agents, "lead")
    assert slots.builder["id"] == "lead"
    assert slots.reviewer["id"] == "other"


def test_single_member_has_no_reviewer() -> None:
    slots = fill_build_review_slots([_agent("lead", "reviewer")], "lead")
    assert slots.builder["id"] == "lead"
    assert slots.reviewer is None


def test_pipeline_orders_by_role_and_keeps_roster_order_within_a_role() -> None:
    agents = [
        _agent("r1", "reviewer"), _agent("i1", "implementer"), _agent("t1", "tester"),
        _agent("p1", "planner"), _agent("i2", "fixer"), _agent("x"),
    ]
    assert [agent["id"] for agent in pipeline_order(agents)] == ["p1", "i1", "i2", "x", "t1", "r1"]


def test_slot_filling_does_not_mutate_its_input() -> None:
    agents = [_agent("lead", "implementer"), _agent("qa", "reviewer")]
    before = [dict(agent) for agent in agents]
    fill_build_review_slots(agents, "lead")
    pipeline_order(agents)
    assert agents == before
