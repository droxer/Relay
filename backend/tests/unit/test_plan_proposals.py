"""Proposed tasks carry keys and acyclic ``after`` links."""

from __future__ import annotations

from relay.projects.plan_apply import prerequisites_for
from relay.projects.setup_result import normalize_setup_proposal

EXISTING = "3f2a9c1e-0b5d-4c6e-9a7f-1d2e3f4a5b6c"


def test_keys_are_unique_and_fallback_for_bad_ones():
    proposal = normalize_setup_proposal(
        {"tasks": [{"key": "Design", "title": "A"}, {"key": "design", "title": "B"}, {"key": "!", "title": "C"}]},
        mode="plan",
    )
    assert [task["key"] for task in proposal["tasks"]] == ["design", "task-2", "task-3"]


def test_after_keeps_earlier_keys_and_existing_ids_only():
    proposal = normalize_setup_proposal(
        {"tasks": [
            {"key": "a", "title": "A", "after": ["b", EXISTING.upper()]},
            {"key": "b", "title": "B", "after": ["a", "a", 7]},
        ]},
        mode="plan",
    )
    first, second = proposal["tasks"]
    assert "after" not in first and first["afterTaskIds"] == [EXISTING]
    assert second["after"] == ["a"]


def test_plan_mode_drops_crew_and_needs_tasks():
    assert normalize_setup_proposal({"goal": "x", "members": []}, mode="plan") is None
    proposal = normalize_setup_proposal(
        {"goal": "x", "leadAgentId": "a", "tasks": [{"title": "T"}]}, mode="plan"
    )
    assert set(proposal) == {"tasks"}


def test_prerequisites_follow_only_applied_and_live_tasks():
    task = {"key": "c", "after": ["a", "b"], "afterTaskIds": [EXISTING, "gone"]}
    assert prerequisites_for(task, {"a": "id-a"}, {EXISTING}) == ["id-a", EXISTING]
