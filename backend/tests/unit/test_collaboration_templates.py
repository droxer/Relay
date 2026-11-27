"""Built-in style templates compile to the turns ADR-021 describes, and the web
preview (`previewSlots` in web/src/lib/collaborationStyle.ts) shows the slots
dispatch actually fills.

The preview cases live in a JSON file both suites read. Regenerate it after an
intended change with `RELAY_UPDATE_STYLE_PREVIEWS=1`.
"""

from __future__ import annotations

import itertools
import json
import os
from pathlib import Path
from typing import Any

import pytest

from relay.collaboration.manifest import create_round_manifest
from relay.collaboration.styles import COLLABORATION_STYLES
from relay.collaboration.templates import (
    BUILTIN_TEMPLATES,
    STYLE_POLICIES,
    compile_style,
)
from relay.teams.dispatch import team_member_assignments

PREVIEWS = Path(__file__).with_name("collaboration_style_previews.json")


def _agent(agent_id: str, role: str | None = None) -> dict[str, Any]:
    return {
        "id": agent_id,
        "executorKind": "claude",
        **({"defaultRole": role} if role else {}),
    }


def _brief(role: str | None) -> str:
    return f"brief:{role}"


def test_every_selectable_style_but_lead_led_is_a_template() -> None:
    assert set(COLLABORATION_STYLES) - {"lead_led"} <= set(BUILTIN_TEMPLATES)
    assert STYLE_POLICIES == {
        "solo": "solo-v1",
        "build_review": "build-review-v1",
        "pipeline": "pipeline-v1",
    }


def test_build_review_fills_a_builder_then_a_closing_reviewer() -> None:
    compiled = compile_style(
        "build_review",
        [_agent("lead", "planner"), _agent("b", "implementer"), _agent("r", "reviewer")],
        "lead",
        role_brief=_brief,
    )
    assert compiled.style == "build_review" and compiled.fallback_from is None
    assert [(t.agent["id"], t.role, t.mode, t.synthesizer) for t in compiled.turns] == [
        ("b", "implementer", "action", False),
        ("r", "reviewer", "review", True),
    ]


def test_build_review_without_a_second_member_compiles_its_solo_fallback() -> None:
    compiled = compile_style("build_review", [_agent("lead")], "lead", role_brief=_brief)
    assert compiled.style == "solo" and compiled.fallback_from == "build_review"
    assert [(t.agent["id"], t.role, t.synthesizer) for t in compiled.turns] == [
        ("lead", "implementer", True)
    ]


@pytest.mark.parametrize(("role", "responsibility"), [
    ("frontend_engineer", "accessibility"),
    ("backend_engineer", "data integrity"),
    ("fullstack_engineer", "end-to-end"),
])
def test_engineering_specialty_keeps_its_role_and_brief_through_dispatch(role: str, responsibility: str) -> None:
    builder = {**_agent("builder", role), "roleLevel": "senior"}
    reviewer = _agent("lead", "reviewer")
    team = {"id": "t", "leadAgentId": "lead", "memberAgentIds": ["lead", "builder"]}

    for style, members, expected_ids in [
        ("build_review", [reviewer, builder], ["builder", "lead"]),
        ("build_review", [builder], ["builder"]),
        ("pipeline", [reviewer, builder], ["builder", "lead"]),
    ]:
        assignments = team_member_assignments(members, team=team, style=style)
        assert [item["agentId"] for item in assignments] == expected_ids
        assignment = assignments[0]
        assert (assignment["role"], assignment["roleLevel"], assignment["mode"]) == (role, "senior", "action")
        assert responsibility in assignment["brief"]
        assert "Senior level" in assignment["brief"]
        if style == "build_review" and len(members) == 2:
            assert "A teammate reviews your work next" in assignment["brief"]
            assert assignments[1]["mode"] == "review"


def test_pipeline_runs_every_member_by_stage_and_only_the_last_closes() -> None:
    compiled = compile_style(
        "pipeline",
        [_agent("lead", "reviewer"), _agent("x"), _agent("p", "planner")],
        "lead",
        role_brief=_brief,
    )
    assert compiled.optional_steps is True
    assert [(t.agent["id"], t.role, t.synthesizer) for t in compiled.turns] == [
        ("p", "planner", False),
        ("x", "implementer", False),
        ("lead", "reviewer", True),
    ]
    # An unroled member keeps the generic brief; only the closer is told to
    # produce the final result.
    assert compiled.turns[1].brief == "brief:None"
    assert compiled.turns[2].brief.startswith("brief:reviewer After completing")


def test_a_round_records_the_template_policy() -> None:
    team = {"id": "t", "leadAgentId": "a", "memberAgentIds": ["a", "b"]}
    assignments = team_member_assignments(
        [_agent("a", "implementer"), _agent("b", "reviewer")],
        team=team,
        style="pipeline",
    )
    manifest = create_round_manifest(
        source="task",
        purpose="accomplish",
        address={"kind": "team", "teamId": "t"},
        assignments=[
            {**item, "assignmentId": f"asg_{index}"}
            for index, item in enumerate(assignments)
        ],
        team_snapshot=assignments[0]["teamSnapshot"],
    )
    assert manifest["workGraph"]["delegationPolicy"]["policy"] == "pipeline-v1"


def _preview_cases() -> list[dict[str, Any]]:
    roles = [None, "researcher", "planner", "designer", "implementer", "tester", "reviewer"]
    cases: list[dict[str, Any]] = []
    for size in (1, 2, 3):
        for member_roles in itertools.product(roles, repeat=size):
            if size == 3 and len(set(member_roles)) < 3:
                continue
            # Three-member rosters vary roles, not lead position.
            for lead in range(size if size < 3 else 1):
                for on_request in [None, size - 1] if size > 1 else [None]:
                    if on_request == lead:
                        continue
                    members = [
                        {
                            "id": f"m{index}",
                            **({"role": role} if role else {}),
                            **({"onRequest": True} if index == on_request else {}),
                        }
                        for index, role in enumerate(member_roles)
                    ]
                    for style in COLLABORATION_STYLES:
                        cases.append(
                            {"style": style, "leadId": f"m{lead}", "members": members}
                        )
    for role in ("frontend_engineer", "backend_engineer", "fullstack_engineer"):
        members = [{"id": "lead", "role": "reviewer"}, {"id": "engineer", "role": role}]
        cases.extend({"style": style, "leadId": "lead", "members": members} for style in COLLABORATION_STYLES)
    return cases


def _dispatched_preview(case: dict[str, Any]) -> dict[str, Any]:
    """The slots a team round with this roster really dispatches."""
    members = case["members"]
    lead_id = case["leadId"]
    ordered = [
        *(m for m in members if m["id"] == lead_id),
        *(m for m in members if m["id"] != lead_id),
    ]
    team = {
        "id": "t",
        "leadAgentId": lead_id,
        "memberAgentIds": [m["id"] for m in ordered],
        "memberConfigs": {
            m["id"]: {"participation": "on_request"} for m in members if m.get("onRequest")
        },
    }
    assignments = team_member_assignments(
        [_agent(m["id"], m.get("role")) for m in ordered],
        team=team,
        style=case["style"],
    )
    snapshot = assignments[0]["teamSnapshot"]
    style = snapshot["collaborationStyle"]

    def slot(item: dict[str, Any]) -> str:
        if style == "lead_led":
            return "lead" if item.get("coordinator") or item.get("synthesizer") else "member"
        if style == "pipeline":
            return "member"
        return "reviewer" if item.get("role") == "reviewer" else "builder"

    return {
        "style": style,
        **(
            {"fallbackFrom": snapshot["styleFallbackFrom"]}
            if snapshot.get("styleFallbackFrom")
            else {}
        ),
        "slots": [{"slot": slot(item), "memberId": item["agentId"]} for item in assignments],
    }


def test_web_preview_cases_match_what_dispatch_fills() -> None:
    expected = [
        {**case, "expected": _dispatched_preview(case)} for case in _preview_cases()
    ]
    if os.environ.get("RELAY_UPDATE_STYLE_PREVIEWS") == "1":
        PREVIEWS.write_text(
            "[\n" + ",\n".join(json.dumps(case) for case in expected) + "\n]\n"
        )
    if not PREVIEWS.exists():
        pytest.fail(f"{PREVIEWS.name} is missing; set RELAY_UPDATE_STYLE_PREVIEWS=1.")
    assert json.loads(PREVIEWS.read_text()) == expected
