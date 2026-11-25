from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from .grants import GRANTS_VERSION, read_grants
from .assignments import effective_assignments

EMPTY_SKILL_BUNDLE: dict[str, Any] = {
    "contract": {"name": "relay.agent.skills", "version": 1},
    "skills": [],
}


@dataclass
class AgentSkillResolution:
    bundle: dict[str, Any] | None
    skipped: list[dict[str, Any]]
    assignments: list[dict[str, Any]]
    skills: dict[str, dict[str, Any]]


def resolve_bundle(
    ctx: Any, agent: dict[str, Any], *, project_id: str | None = None,
) -> tuple[dict[str, Any] | None, list[dict[str, Any]]]:
    result = resolve_agent_skills(ctx, agent, project_id=project_id)
    return result.bundle, result.skipped


def resolve_agent_skills(
    ctx: Any, agent: dict[str, Any], *, project_id: str | None = None, include_files: bool = True,
) -> AgentSkillResolution:
    store = ctx.skill_store
    policy = agent.get("skillPolicy") or {}
    scoped = effective_assignments(ctx, agent, project_id=project_id) if hasattr(store, "list_assignments") else []
    if not (isinstance(policy, dict) and "version" in policy) and not scoped:
        return AgentSkillResolution(None, [], [], {})

    grants = {
        item["skillId"]: {"skillId": item["skillId"], "pin": item["pin"], "assignmentMode": item["mode"]}
        for item in scoped
    }
    grants.update((item["skillId"], {**item, "assignmentMode": "optional"}) for item in read_grants(agent))
    unsupported = []
    if isinstance(policy, dict) and policy.get("version") not in (None, GRANTS_VERSION):
        raw = policy.get("grants", [])
        if isinstance(raw, list):
            unsupported = [item["skillId"] for item in raw if isinstance(item, dict) and isinstance(item.get("skillId"), str)]

    skills = store.get_skills_by_ids(set(grants) | set(unsupported))
    skipped = [_skipped(key, skills.get(key, {}).get("slug"), "unsupported-policy") for key in unsupported]
    owner = agent.get("supervisorUserId")
    eligible = []
    for skill_id, grant in grants.items():
        skill = skills.get(skill_id)
        if not skill:
            skipped.append(
                _skipped(
                    skill_id,
                    None,
                    "skill-missing",
                    grant.get("assignmentMode"),
                )
            )
            continue
        slug = skill.get("slug")
        if skill.get("deletedAt"):
            skipped.append(
                _skipped(skill_id, slug, "deleted", grant.get("assignmentMode"))
            )
            continue
        if skill.get("visibility") != "public" and skill.get("ownerUserId") != owner:
            skipped.append(
                _skipped(
                    skill_id,
                    slug,
                    "visibility-revoked",
                    grant.get("assignmentMode"),
                )
            )
            continue
        name = skill.get("name")
        if (
            not isinstance(slug, str)
            or not isinstance(name, str)
            or slug.rsplit("/", 1)[-1] != name
        ):
            skipped.append(
                _skipped(
                    skill_id,
                    slug,
                    "invalid-bundle",
                    grant.get("assignmentMode"),
                )
            )
            continue
        revision_id = _pinned_revision_id(skill, grant.get("pin"))
        eligible.append((skill_id, slug, revision_id, grant))
    revisions = store.get_revisions_by_ids({key for _, _, key, _ in eligible if key})
    resolved = []
    for skill_id, slug, revision_id, grant in eligible:
        revision = revisions.get(revision_id)
        if not revision or revision.get("skillId") != skill_id:
            skipped.append(
                _skipped(
                    skill_id,
                    slug,
                    "revision-missing",
                    grant.get("assignmentMode"),
                )
            )
            continue
        resolved.append(
            {
                "skillId": skill_id,
                "revisionId": revision_id,
                "slug": slug,
                "manifestSha256": revision["manifestSha256"],
                "assignmentMode": grant.get("assignmentMode", "optional"),
            }
        )
    if include_files:
        files = store.revision_files_by_ids({item["revisionId"] for item in resolved})
        for item in resolved:
            item["files"] = [
                {key: file[key] for key in ("path", "sha256", "bytes")}
                for file in files.get(item["revisionId"], ())
            ]
    resolved.sort(key=lambda item: (item["slug"], item["skillId"]))
    skipped.sort(
        key=lambda item: (item.get("slug") or "", item["skillId"], item["reason"])
    )
    return AgentSkillResolution({**_empty_bundle(), "skills": resolved}, skipped, scoped, skills)


def _pinned_revision_id(skill: dict[str, Any], pin: Any) -> Any:
    if pin == "latest":
        return skill.get("currentRevisionId")
    if pin == "stable":
        return skill.get("stableRevisionId") or skill.get("currentRevisionId")
    if isinstance(pin, dict):
        return pin.get("revisionId")
    return None


def _empty_bundle() -> dict[str, Any]:
    return {"contract": dict(EMPTY_SKILL_BUNDLE["contract"]), "skills": []}


def _skipped(
    skill_id: str,
    slug: str | None,
    reason: str,
    assignment_mode: str | None = None,
) -> dict[str, Any]:
    return {
        "skillId": skill_id,
        **({"slug": slug} if slug else {}),
        "reason": reason,
        **(
            {"assignmentMode": "required"}
            if assignment_mode == "required"
            else {}
        ),
    }
