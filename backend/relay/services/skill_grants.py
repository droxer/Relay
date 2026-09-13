from __future__ import annotations

from typing import Any

from ..core.ids import now_iso

GRANTS_VERSION = 1


class SkillGrantError(ValueError):
    def __init__(self, code: str, message: str | None = None):
        self.code = code
        super().__init__(message or code)


def read_grants(agent: dict[str, Any]) -> list[dict[str, Any]]:
    policy = agent.get("skillPolicy") or {}
    if not isinstance(policy, dict) or policy.get("version") not in (
        None,
        GRANTS_VERSION,
    ):
        return []
    grants = policy.get("grants", [])
    if not isinstance(grants, list):
        return []
    return [
        dict(item)
        for item in grants
        if isinstance(item, dict) and isinstance(item.get("skillId"), str)
    ]


def grant(
    ctx: Any,
    skill_id: str,
    agent_ids: list[str],
    employee_id: str,
    pin: str | dict[str, str] = "latest",
) -> list[dict[str, Any]]:
    skill = _visible_skill(ctx, skill_id, employee_id)
    normalized_pin = _validate_pin(ctx, skill_id, pin)
    agents = _owned_agents(ctx, agent_ids, employee_id)
    for agent in agents:
        _ensure_mutable_policy(agent.get("skillPolicy"))

    updated = []
    for agent in agents:
        entry = {
            "skillId": skill["id"],
            "pin": normalized_pin,
            "grantedAt": now_iso(),
            "grantedByEmployeeId": employee_id,
        }

        def transform(
            policy: dict[str, Any], entry: dict[str, Any] = entry
        ) -> dict[str, Any]:
            _ensure_mutable_policy(policy)
            others = [
                item for item in _grants_of(policy) if item.get("skillId") != skill_id
            ]
            return {**policy, "version": GRANTS_VERSION, "grants": [*others, entry]}

        updated.append(ctx.agent_store.transform_skill_policy(agent["id"], transform))
    return updated


def revoke(ctx: Any, skill_id: str, agent_id: str, employee_id: str) -> dict[str, Any]:
    agent = _owned_agents(ctx, [agent_id], employee_id)[0]
    _ensure_mutable_policy(agent.get("skillPolicy"))

    def transform(policy: dict[str, Any]) -> dict[str, Any]:
        _ensure_mutable_policy(policy)
        return {
            **policy,
            "version": GRANTS_VERSION,
            "grants": [
                item for item in _grants_of(policy) if item.get("skillId") != skill_id
            ],
        }

    return ctx.agent_store.transform_skill_policy(agent_id, transform)


def _visible_skill(ctx: Any, skill_id: str, employee_id: str) -> dict[str, Any]:
    skill = ctx.skill_store.get_skill(skill_id)
    if (
        not skill
        or skill.get("deletedAt")
        or (
            skill.get("visibility") != "org"
            and skill.get("ownerEmployeeId") != employee_id
        )
    ):
        raise SkillGrantError("skill-not-found")
    return skill


def _validate_pin(ctx: Any, skill_id: str, pin: Any) -> str | dict[str, str]:
    if pin == "latest":
        return "latest"
    if (
        not isinstance(pin, dict)
        or set(pin) != {"revisionId"}
        or not isinstance(pin["revisionId"], str)
    ):
        raise SkillGrantError("invalid-pin")
    revision = ctx.skill_store.get_revision(pin["revisionId"])
    if not revision or revision.get("skillId") != skill_id:
        raise SkillGrantError("revision-not-found")
    return {"revisionId": pin["revisionId"]}


def _owned_agents(
    ctx: Any, agent_ids: list[str], employee_id: str
) -> list[dict[str, Any]]:
    if (
        not isinstance(agent_ids, list)
        or not agent_ids
        or any(not isinstance(item, str) for item in agent_ids)
    ):
        raise SkillGrantError("invalid-agent-ids")
    agents = []
    seen = set()
    for agent_id in agent_ids:
        if agent_id in seen:
            continue
        seen.add(agent_id)
        agent = ctx.agent_store.get_agent(agent_id)
        if not agent or agent.get("deletedAt"):
            raise SkillGrantError("agent-not-found")
        if agent.get("supervisorEmployeeId") != employee_id:
            raise SkillGrantError("not-agent-owner")
        agents.append(agent)
    return agents


def _ensure_mutable_policy(policy: Any) -> None:
    if isinstance(policy, dict) and policy.get("version") not in (None, GRANTS_VERSION):
        raise SkillGrantError("unsupported-policy-version")


def _grants_of(policy: dict[str, Any]) -> list[dict[str, Any]]:
    grants = policy.get("grants", [])
    return (
        [
            dict(item)
            for item in grants
            if isinstance(item, dict) and isinstance(item.get("skillId"), str)
        ]
        if isinstance(grants, list)
        else []
    )
