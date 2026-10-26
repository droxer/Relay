from __future__ import annotations

import pytest
from relay.projects.setup import ProjectSetupError, choose_setup_agent, resolved_setup
from relay.projects.setup_result import completed_setup, normalize_setup_proposal


def test_proposal_is_held_to_the_shape_the_patch_accepts() -> None:
    proposal = normalize_setup_proposal({
        "name": "  Launch  ",
        "goal": "g" * 400,
        "leadAgentId": "nobody",
        "members": [
            {"agentId": "a", "role": "planner", "responsibilities": "Plan"},
            {"agentId": "a", "role": "tester", "responsibilities": "Duplicate"},
            {"agentId": "b", "role": "wizard", "responsibilities": "Build"},
            {"agentId": "c", "role": "tester", "responsibilities": "   "},
            "not a member",
        ],
        "firstTasks": [{"title": "One"}, {"description": "no title"}],
        "unknown": "ignored",
    })

    assert proposal is not None
    assert proposal["name"] == "Launch"
    assert len(proposal["goal"]) == 280
    assert [m["agentId"] for m in proposal["members"]] == ["a", "b"]
    assert proposal["members"][1]["role"] == "implementer"
    assert proposal["leadAgentId"] == "a", "an unknown lead falls back to the first member"
    assert proposal["tasks"] == [{"key": "task-1", "title": "One"}], "an unkeyed task is keyed by position"
    assert "unknown" not in proposal


@pytest.mark.parametrize("raw", [None, [], "text", {"name": "Only a name"}])
def test_nothing_usable_is_no_proposal(raw) -> None:
    assert normalize_setup_proposal(raw) is None


def test_a_late_result_never_reopens_a_decided_setup() -> None:
    applied = {"state": "applied", "threadId": "t"}
    assert completed_setup(applied, {"goal": "x"}, exit_code=0) is None
    assert completed_setup(None, {"goal": "x"}, exit_code=0) is None


def test_a_failed_run_keeps_the_earlier_proposal_visible() -> None:
    drafting = {"state": "drafting", "proposal": {"goal": "old"}}

    result = completed_setup(drafting, {"goal": "new"}, exit_code=1)

    assert result["state"] == "failed"
    assert result["error"] == "setup_run_failed"
    assert result["proposal"] == {"goal": "old"}


def test_applying_requires_a_proposal_and_closes_the_setup() -> None:
    with pytest.raises(ProjectSetupError, match="project_setup_not_proposed"):
        resolved_setup({"state": "drafting"}, "applied")
    with pytest.raises(ProjectSetupError, match="project_setup_not_open"):
        resolved_setup({"state": "applied"}, "dismissed")
    assert resolved_setup({"state": "failed"}, "dismissed")["state"] == "dismissed"
    assert resolved_setup({"state": "proposed"}, "applied")["state"] == "applied"


def test_setup_agent_defaults_to_a_planner() -> None:
    candidates = [
        {"agentId": "a", "defaultRole": "implementer"},
        {"agentId": "b", "defaultRole": "planner"},
    ]
    assert choose_setup_agent(candidates, None) == "b"
    assert choose_setup_agent(candidates, "a") == "a"
    with pytest.raises(ProjectSetupError, match="project_setup_agent_unavailable"):
        choose_setup_agent(candidates, "z")
    with pytest.raises(ProjectSetupError, match="project_setup_no_agents"):
        choose_setup_agent([], None)


def test_refining_an_existing_crew_defaults_to_its_lead() -> None:
    candidates = [{"agentId": "a", "defaultRole": "planner"}, {"agentId": "lead"}]
    assert choose_setup_agent(candidates, None, lead_agent_id="lead") == "lead"
    assert choose_setup_agent(candidates, None, lead_agent_id="gone") == "a"


def test_a_draft_still_dispatching_blocks_a_second_start() -> None:
    from relay.core.ids import now_iso
    from relay.projects.setup import setup_in_progress

    assert setup_in_progress({"state": "drafting", "threadId": None, "startedAt": now_iso()}, None)
    assert not setup_in_progress(
        {"state": "drafting", "threadId": None, "startedAt": "2020-01-01T00:00:00.000Z"}, None
    ), "a draft whose dispatch crashed long ago must not block forever"
