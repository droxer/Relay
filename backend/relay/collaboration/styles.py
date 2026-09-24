"""Team collaboration styles: the one place a style is chosen and slots filled.

A style decides which team members take a turn in an accomplish round and in
what order. Everything after that — work gates, repair, delivery — is shared.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Any

COLLABORATION_STYLES: tuple[str, ...] = ("solo", "build_review", "pipeline", "lead_led")
DEFAULT_COLLABORATION_STYLE = "build_review"
LEAD_LED = "lead_led"
STYLE_POLICIES: dict[str, str] = {
    "solo": "solo-v1",
    "build_review": "build-review-v1",
    "pipeline": "pipeline-v1",
}
BUILDER_ROLES = frozenset({"implementer", "fixer"})
PIPELINE_STAGE: dict[str, int] = {
    "planner": 0,
    "implementer": 1,
    "fixer": 1,
    "tester": 2,
    "reviewer": 3,
}


class CollaborationStyleError(ValueError):
    """A collaboration style value outside the supported set."""


def validate_collaboration_style(value: Any, field: str = "collaborationStyle") -> str:
    if value not in COLLABORATION_STYLES:
        raise CollaborationStyleError(
            f"{field} must be one of: {', '.join(COLLABORATION_STYLES)}."
        )
    return value


def resolve_collaboration_style(
    team: dict[str, Any] | None,
    task: dict[str, Any] | None,
    requested: str | None,
) -> str:
    """Message beats task beats team beats the default."""
    for candidate in (
        requested,
        (task or {}).get("collaborationStyle"),
        (team or {}).get("collaborationStyle"),
    ):
        if candidate is not None:
            return validate_collaboration_style(candidate)
    return DEFAULT_COLLABORATION_STYLE


@dataclass(frozen=True)
class StyleSlots:
    builder: dict[str, Any]
    reviewer: dict[str, Any] | None


def _role(agent: dict[str, Any]) -> str | None:
    return agent.get("defaultRole")


def fill_build_review_slots(
    agents: list[dict[str, Any]], lead_agent_id: str | None
) -> StyleSlots:
    lead = next((agent for agent in agents if agent["id"] == lead_agent_id), None)
    if lead is not None and _role(lead) in BUILDER_ROLES:
        builder = lead
    else:
        builder = (
            next((agent for agent in agents if _role(agent) in BUILDER_ROLES), None)
            or lead
            or agents[0]
        )
    others = [agent for agent in agents if agent["id"] != builder["id"]]
    reviewer = (
        next((agent for agent in others if _role(agent) == "reviewer"), None)
        or next((agent for agent in others if _role(agent) == "tester"), None)
        or next((agent for agent in others if agent["id"] == lead_agent_id), None)
        or (others[0] if others else None)
    )
    return StyleSlots(builder=builder, reviewer=reviewer)


def pipeline_order(agents: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return sorted(agents, key=lambda agent: PIPELINE_STAGE.get(_role(agent), 1))
