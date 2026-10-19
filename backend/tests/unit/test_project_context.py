from __future__ import annotations

import pytest
from relay.persistence.project.store import ProjectValidationError
from relay.projects.catalog import (
    PROJECT_CONTEXT_MAX_LENGTH,
    PROJECT_GOAL_MAX_LENGTH,
    update_project_payload,
)
from relay.projects.context import project_context_brief
from relay.projects.runtime import project_runtime_snapshot


def _project(**overrides) -> dict:
    return {
        "id": "project-1",
        "ownerUserId": "alice",
        "name": "Website launch",
        "description": "Marketing site for the spring release.",
        "goal": "Ship the site by Friday",
        "context": "Use Next.js. Every page needs a Lighthouse score above 90.",
        "contextRevision": 2,
        "computerId": "device:alice:main",
        "workspaceSubpath": "projects/project-1",
        "leadAgentId": "lead",
        "enabled": True,
        "version": 4,
        "members": [
            {"agentId": "lead", "role": "planner", "responsibilities": "Plan the launch", "enabled": True},
            {"agentId": "builder", "role": "implementer", "responsibilities": "Build pages", "enabled": True},
            {"agentId": "idle", "role": "tester", "responsibilities": "Test", "enabled": False},
        ],
        **overrides,
    }


def test_snapshot_carries_what_the_project_is_for() -> None:
    snapshot = project_runtime_snapshot(_project())

    assert snapshot["name"] == "Website launch"
    assert snapshot["goal"] == "Ship the site by Friday"
    assert snapshot["context"].startswith("Use Next.js")
    assert snapshot["contextRevision"] == 2
    assert snapshot["projectRevision"] == 4


def test_brief_names_goal_crew_and_context() -> None:
    brief = project_context_brief(
        project_runtime_snapshot(_project()), {"lead": "Ada", "builder": "Bo"}
    )

    assert brief is not None
    assert brief.splitlines()[0] == "Project: Website launch"
    assert "Goal: Ship the site by Friday" in brief
    assert "- Ada (planner, lead): Plan the launch" in brief
    assert "- Bo (implementer): Build pages" in brief
    assert "Test" not in brief.split("Project context")[0], "disabled members stay off the crew"
    assert brief.rstrip().endswith("Lighthouse score above 90.")


def test_brief_falls_back_to_role_never_raw_agent_id() -> None:
    brief = project_context_brief(project_runtime_snapshot(_project()))

    assert brief is not None
    assert "- planner, lead: Plan the launch" in brief
    assert "builder:" not in brief


def test_legacy_snapshot_without_a_name_renders_nothing() -> None:
    assert project_context_brief(None) is None
    assert project_context_brief({"projectId": "p", "members": []}) is None


def test_editing_the_context_bumps_its_revision() -> None:
    current = _project()

    patch, version = update_project_payload(
        "alice",
        current,
        {"expectedVersion": 4, "context": "  New rules  "},
        agent_store=None,
        placement_store=None,
    )

    assert version == 4
    assert patch == {"context": "New rules", "contextRevision": 3}


def test_unchanged_context_keeps_its_revision() -> None:
    current = _project()

    patch, _ = update_project_payload(
        "alice",
        current,
        {"expectedVersion": 4, "context": current["context"], "goal": " Ship it "},
        agent_store=None,
        placement_store=None,
    )

    assert patch == {"context": current["context"], "goal": "Ship it"}


@pytest.mark.parametrize(
    ("field", "value", "code"),
    [
        ("goal", "x" * (PROJECT_GOAL_MAX_LENGTH + 1), "project_goal_too_long"),
        ("context", "x" * (PROJECT_CONTEXT_MAX_LENGTH + 1), "project_context_too_long"),
        ("goal", 7, "project_goal_invalid"),
        ("context", ["rules"], "project_context_invalid"),
    ],
)
def test_goal_and_context_are_validated(field: str, value: object, code: str) -> None:
    with pytest.raises(ProjectValidationError) as error:
        update_project_payload(
            "alice",
            _project(),
            {"expectedVersion": 4, field: value},
            agent_store=None,
            placement_store=None,
        )
    assert error.value.code == code


def test_suggestions_are_attributed_bounded_and_deduplicated() -> None:
    from relay.projects.context import (
        context_suggestions_from_run,
        merge_context_suggestions,
    )

    incoming = context_suggestions_from_run(
        [{"text": "  Use pnpm  "}, {"text": ""}, "bad", {"text": "Two"}, {"text": "Three"}, {"text": "Four"}],
        thread_id="t", run_id="r", agent_id="a", created_at="now",
    )
    assert [item["text"] for item in incoming] == ["Use pnpm", "Two", "Three"]
    assert incoming[0] == {"id": "r:0", "text": "Use pnpm", "threadId": "t", "runId": "r", "agentId": "a", "createdAt": "now"}

    merged = merge_context_suggestions([{"id": "old", "text": "two"}], incoming, "Always use pnpm")
    assert [item["text"] for item in merged] == ["two", "Three"]
