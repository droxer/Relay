from __future__ import annotations

from typing import Any


class SkillAssignmentError(ValueError):
    def __init__(self, code: str, message: str | None = None):
        self.code = code
        super().__init__(message or code)


def assign(
    ctx: Any,
    skill_id: str,
    target_type: str,
    target_id: str,
    employee_id: str,
    *,
    mode: str = "optional",
    pin: str | dict[str, str] = "stable",
    invocation: str = "implicit",
    actor_is_admin: bool = False,
) -> dict[str, Any]:
    skill = _visible_skill(ctx, skill_id, employee_id)
    _validate_target_owner(
        ctx,
        target_type,
        target_id,
        employee_id,
        actor_is_admin=actor_is_admin,
    )
    _validate_policy(ctx, skill_id, mode, pin, invocation)
    try:
        return ctx.skill_store.upsert_assignment(
            skill["id"],
            target_type=target_type,
            target_id=target_id,
            mode=mode,
            pin=pin,
            invocation=invocation,
            created_by_employee_id=employee_id,
        )
    except KeyError as error:
        raise SkillAssignmentError("skill-not-found") from error


def revoke(
    ctx: Any,
    assignment_id: str,
    employee_id: str,
    *,
    actor_is_admin: bool = False,
) -> dict[str, Any]:
    assignment = ctx.skill_store.get_assignment(assignment_id)
    if not assignment:
        raise SkillAssignmentError("assignment-not-found")
    _validate_target_owner(
        ctx,
        assignment["targetType"],
        assignment["targetId"],
        employee_id,
        actor_is_admin=actor_is_admin,
    )
    try:
        return ctx.skill_store.delete_assignment(assignment_id)
    except KeyError as error:
        raise SkillAssignmentError("assignment-not-found") from error


def effective_assignments(
    ctx: Any,
    agent: dict[str, Any],
    *,
    project_id: str | None = None,
) -> list[dict[str, Any]]:
    employee_id = agent.get("supervisorEmployeeId")
    agent_id = agent.get("id")
    if not employee_id or not agent_id:
        return []
    targets = [("org", "org"), ("employee", employee_id), ("agent", agent_id)]
    if getattr(ctx, "team_store", None) is not None:
        for team in ctx.team_store.list_teams(owner_employee_id=employee_id):
            if agent_id in (team.get("memberAgentIds") or []):
                targets.append(("team", team["id"]))
    if project_id and _agent_is_project_member(ctx, project_id, agent_id):
        targets.append(("project", project_id))
    assignments = ctx.skill_store.list_assignments(targets=targets)
    rank = {"org": 0, "employee": 1, "team": 2, "project": 3, "agent": 4}
    effective: dict[str, dict[str, Any]] = {}
    for assignment in sorted(
        assignments,
        key=lambda item: (
            rank[item["targetType"]],
            item["updatedAt"],
            item["id"],
        ),
    ):
        if assignment["mode"] == "suggested" or assignment["invocation"] == "explicit":
            continue
        effective[assignment["skillId"]] = assignment
    return sorted(effective.values(), key=lambda item: (item["skillId"], item["id"]))


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
        raise SkillAssignmentError("skill-not-found")
    return skill


def _validate_target_owner(
    ctx: Any,
    target_type: str,
    target_id: str,
    employee_id: str,
    *,
    actor_is_admin: bool,
) -> None:
    if target_type == "org":
        if not actor_is_admin or target_id != "org":
            raise SkillAssignmentError("not-target-owner")
        return
    if target_type == "employee":
        if target_id != employee_id:
            raise SkillAssignmentError("not-target-owner")
        return
    if target_type == "agent":
        target = ctx.agent_store.get_agent(target_id)
        unavailable = not target or target.get("deletedAt")
        owner = target.get("supervisorEmployeeId") if target else None
    elif target_type == "team":
        target = ctx.team_store.get_team(target_id)
        unavailable = not target or target.get("deletedAt")
        owner = target.get("ownerEmployeeId") if target else None
    elif target_type == "project":
        target = ctx.project_store.get_project(target_id)
        unavailable = not target or target.get("archivedAt")
        owner = target.get("ownerEmployeeId") if target else None
    else:
        raise SkillAssignmentError("invalid-assignment-target")
    if unavailable:
        raise SkillAssignmentError("assignment-target-not-found")
    if owner != employee_id and not actor_is_admin:
        raise SkillAssignmentError("not-target-owner")


def _validate_policy(
    ctx: Any,
    skill_id: str,
    mode: str,
    pin: str | dict[str, str],
    invocation: str,
) -> None:
    if mode not in {"optional", "required", "suggested"}:
        raise SkillAssignmentError("invalid-assignment-mode")
    if invocation not in {"implicit", "explicit"}:
        raise SkillAssignmentError("invalid-invocation-policy")
    if mode == "suggested" and invocation != "explicit":
        raise SkillAssignmentError("suggested-requires-explicit-invocation")
    if isinstance(pin, str) and pin in {"latest", "stable"}:
        return
    if (
        not isinstance(pin, dict)
        or set(pin) != {"revisionId"}
        or not isinstance(pin["revisionId"], str)
    ):
        raise SkillAssignmentError("invalid-pin")
    revision = ctx.skill_store.get_revision(pin["revisionId"])
    if not revision or revision.get("skillId") != skill_id:
        raise SkillAssignmentError("revision-not-found")


def _agent_is_project_member(ctx: Any, project_id: str, agent_id: str) -> bool:
    if getattr(ctx, "project_store", None) is None:
        return False
    project = ctx.project_store.get_project(project_id)
    if not project or project.get("archivedAt"):
        return False
    if project.get("leadAgentId") == agent_id:
        return True
    return any(
        member.get("agentId") == agent_id and member.get("enabled", True)
        for member in (project.get("members") or [])
        if isinstance(member, dict)
    )
