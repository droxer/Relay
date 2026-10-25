"""Collaboration style templates: a style as data, compiled by one function.

A template lists the turns of an accomplish round; `compile_style` fills them
from a roster. Lead-led is not a template: its lead plans the rest of the round
at run time (ADR-023).
"""
from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from typing import Any, Literal

from .styles import StyleSlots, fill_build_review_slots, pipeline_order

# Who takes a step: the Build → Review builder or reviewer slot, or every
# participating member in pipeline order (one turn each).
StepWho = Literal["builder", "reviewer", "each_member"]


@dataclass(frozen=True)
class TemplateStep:
    who: StepWho
    mode: str
    # The role the turn runs as; None keeps the member's own role.
    role: str | None = None
    # None uses the role's standard brief.
    brief: str | None = None
    # The step whose (last) turn owns the round's final result.
    closing: bool = False
    # Appended to the closing turn's brief.
    closing_note: str = ""


@dataclass(frozen=True)
class StyleTemplate:
    style: str
    policy: str
    steps: tuple[TemplateStep, ...]
    # Compiled instead when a step's slot has nobody to fill it.
    fallback: str | None = None
    # A non-closing turn honours its member's `required` setting.
    optional_steps: bool = False


@dataclass(frozen=True)
class StyleTurn:
    agent: dict[str, Any]
    role: str
    mode: str
    synthesizer: bool
    brief: str


@dataclass(frozen=True)
class CompiledStyle:
    style: str
    fallback_from: str | None
    turns: tuple[StyleTurn, ...]
    optional_steps: bool


SOLO_BRIEF = "Complete the shared goal yourself and report the delivered result to the user."
BUILDER_BRIEF = (
    "Implement the shared goal. A teammate reviews your work next; if it reports "
    "findings you will be asked to repair them."
)
REVIEWER_BRIEF = (
    "Review the builder's changes against the goal and acceptance criteria. Report "
    "findings on the builder's work item to request changes. Report done with "
    "evidence only when the result is acceptable, then summarize what was delivered "
    "for the user."
)
PIPELINE_CLOSING_NOTE = (
    " After completing your own contribution, "
    "produce one coherent final result for the user, including "
    "delivered changes, validation results, and remaining limitations."
)

BUILTIN_TEMPLATES: dict[str, StyleTemplate] = {
    template.style: template
    for template in (
        StyleTemplate(
            style="solo",
            policy="solo-v1",
            steps=(
                TemplateStep(
                    who="builder", mode="action", role="implementer",
                    brief=SOLO_BRIEF, closing=True,
                ),
            ),
        ),
        StyleTemplate(
            style="build_review",
            policy="build-review-v1",
            steps=(
                TemplateStep(
                    who="builder", mode="action", role="implementer", brief=BUILDER_BRIEF
                ),
                TemplateStep(
                    who="reviewer", mode="review", role="reviewer",
                    brief=REVIEWER_BRIEF, closing=True,
                ),
            ),
            fallback="solo",
        ),
        StyleTemplate(
            style="pipeline",
            policy="pipeline-v1",
            steps=(
                TemplateStep(
                    who="each_member", mode="action", closing=True,
                    closing_note=PIPELINE_CLOSING_NOTE,
                ),
            ),
            optional_steps=True,
        ),
    )
}
STYLE_POLICIES: dict[str, str] = {
    style: template.policy for style, template in BUILTIN_TEMPLATES.items()
}


class _UnfilledSlot(Exception):
    pass


def compile_style(
    style: str,
    agents: list[dict[str, Any]],
    lead_agent_id: str | None,
    *,
    role_brief: Callable[[str | None], str],
) -> CompiledStyle:
    """Fill a built-in template's steps from the participating members.

    `role_brief` words the standard brief for a role; it lives with the team
    briefs because Lead-led uses it too.
    """
    template = BUILTIN_TEMPLATES[style]
    try:
        turns = _template_turns(template, agents, lead_agent_id, role_brief)
    except _UnfilledSlot:
        if template.fallback is None:
            raise ValueError(f"{style} has no fallback for an unfilled slot.") from None
        fallback = compile_style(
            template.fallback, agents, lead_agent_id, role_brief=role_brief
        )
        return CompiledStyle(
            style=fallback.style,
            fallback_from=style,
            turns=fallback.turns,
            optional_steps=fallback.optional_steps,
        )
    return CompiledStyle(
        style=style,
        fallback_from=None,
        turns=tuple(turns),
        optional_steps=template.optional_steps,
    )


def _template_turns(
    template: StyleTemplate,
    agents: list[dict[str, Any]],
    lead_agent_id: str | None,
    role_brief: Callable[[str | None], str],
) -> list[StyleTurn]:
    slots = (
        fill_build_review_slots(agents, lead_agent_id)
        if any(step.who != "each_member" for step in template.steps)
        else None
    )
    turns: list[StyleTurn] = []
    for step in template.steps:
        members = _step_members(step.who, agents, slots)
        last = len(members) - 1
        for index, agent in enumerate(members):
            own_role = agent.get("defaultRole")
            closing = step.closing and index == last
            brief = step.brief if step.brief is not None else role_brief(own_role)
            turns.append(
                StyleTurn(
                    agent=agent,
                    role=step.role or own_role or "implementer",
                    mode=step.mode,
                    synthesizer=closing,
                    brief=brief + (step.closing_note if closing else ""),
                )
            )
    return turns


def _step_members(
    who: StepWho, agents: list[dict[str, Any]], slots: StyleSlots | None
) -> list[dict[str, Any]]:
    if who == "each_member":
        return pipeline_order(agents)
    assert slots is not None
    member = slots.builder if who == "builder" else slots.reviewer
    if member is None:
        raise _UnfilledSlot(who)
    return [member]
