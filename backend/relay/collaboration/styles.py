"""Team collaboration styles: the one place a style is chosen and slots filled.

A style decides which team members take a turn in an accomplish round and in
what order. Everything after that — work gates, repair, delivery — is shared.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Any

# Solo is an internal one-member fallback, never a selectable team style.
COLLABORATION_STYLES: tuple[str, ...] = ("build_review", "pipeline", "lead_led")
DEFAULT_COLLABORATION_STYLE = "build_review"
LEAD_LED = "lead_led"
BUILDER_ROLES = frozenset({"implementer", "fixer"})
# Investigation and planning come first, then design, then the writers, then
# verification and delivery work, and review last. Lead planning, the lead-led
# member order and Pipeline all sort by this.
ROLE_STAGE: dict[str, int] = {
    "researcher": 0,
    "planner": 0,
    "designer": 1,
    "implementer": 2,
    "fixer": 2,
    "tester": 3,
    "writer": 3,
    "devops": 3,
    "reviewer": 4,
}


def role_stage(role: str | None) -> int:
    """Pipeline stage for a role; a missing or unknown role sits with the implementers."""
    return 2 if role is None else ROLE_STAGE.get(role, 2)


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
    if requested is not None:
        return validate_collaboration_style(requested)
    for candidate in (
        (task or {}).get("collaborationStyle"),
        (team or {}).get("collaborationStyle"),
    ):
        if candidate is not None:
            # Preserve stored history, but retire explicit Solo for future work.
            if candidate == "solo":
                return DEFAULT_COLLABORATION_STYLE
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
        first_builder: dict[str, Any] | None = next(
            (agent for agent in agents if _role(agent) in BUILDER_ROLES), None
        )
        builder = first_builder or lead or agents[0]
    others = [agent for agent in agents if agent["id"] != builder["id"]]
    reviewer = (
        next((agent for agent in others if _role(agent) == "reviewer"), None)
        or next((agent for agent in others if _role(agent) == "tester"), None)
        or next((agent for agent in others if agent["id"] == lead_agent_id), None)
        or (others[0] if others else None)
    )
    return StyleSlots(builder=builder, reviewer=reviewer)


def pipeline_order(agents: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return sorted(agents, key=lambda agent: role_stage(_role(agent)))
