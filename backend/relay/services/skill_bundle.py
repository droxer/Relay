from __future__ import annotations

from typing import Any

from .skill_grants import GRANTS_VERSION, read_grants
from .skill_assignments import effective_assignments

EMPTY_SKILL_BUNDLE = {
    "contract": {"name": "relay.agent.skills", "version": 1},
    "skills": [],
}


def resolve_bundle(
    ctx: Any, agent: dict[str, Any], *, project_id: str | None = None
) -> tuple[dict[str, Any] | None, list[dict[str, Any]]]:
    policy = agent.get("skillPolicy") or {}
    scoped = (
        effective_assignments(ctx, agent, project_id=project_id)
        if hasattr(ctx.skill_store, "list_assignments")
        else []
    )
    managed_legacy = isinstance(policy, dict) and "version" in policy
    if not managed_legacy and not scoped:
        return None, []
    grants = [
        {
            "skillId": item["skillId"],
            "pin": item["pin"],
            "assignmentMode": item["mode"],
        }
        for item in scoped
    ]
    if isinstance(policy, dict) and policy.get("version") not in (None, GRANTS_VERSION):
        skipped = []
        raw = policy.get("grants", [])
        for item in raw if isinstance(raw, list) else []:
            if not isinstance(item, dict) or not isinstance(item.get("skillId"), str):
                continue
            skill = ctx.skill_store.get_skill(item["skillId"])
            skipped.append(
                _skipped(
                    item["skillId"],
                    skill.get("slug") if skill else None,
                    "unsupported-policy",
                )
            )
    else:
        skipped = []
        # Direct v1 agent grants are retained as the compatibility override.
        direct = {
            item["skillId"]: {**item, "assignmentMode": "optional"}
            for item in read_grants(agent)
        }
        grants = [item for item in grants if item["skillId"] not in direct]
        grants.extend(direct.values())

    owner = agent.get("supervisorEmployeeId")
    resolved, seen = [], set()
    for grant in grants:
        skill_id = grant["skillId"]
        if skill_id in seen:
            continue
        seen.add(skill_id)
        skill = ctx.skill_store.get_skill(skill_id)
        if not skill:
            skipped.append(_skipped(skill_id, None, "skill-missing"))
            continue
        slug = skill.get("slug")
        if skill.get("deletedAt"):
            skipped.append(_skipped(skill_id, slug, "deleted"))
            continue
        if skill.get("visibility") != "org" and skill.get("ownerEmployeeId") != owner:
            skipped.append(_skipped(skill_id, slug, "visibility-revoked"))
            continue
        pin = grant.get("pin")
        revision_id = (
            skill.get("currentRevisionId")
            if pin == "latest"
            else skill.get("stableRevisionId") or skill.get("currentRevisionId")
            if pin == "stable"
            else pin.get("revisionId")
            if isinstance(pin, dict)
            else None
        )
        revision = ctx.skill_store.get_revision(revision_id) if revision_id else None
        if not revision or revision.get("skillId") != skill_id:
            skipped.append(_skipped(skill_id, slug, "revision-missing"))
            continue
        files = ctx.skill_store.revision_files(revision_id)
        resolved.append(
            {
                "_catalogName": skill.get("name") or skill_id,
                "skillId": skill_id,
                "revisionId": revision_id,
                "slug": slug,
                "manifestSha256": revision["manifestSha256"],
                "assignmentMode": grant.get("assignmentMode", "optional"),
                "files": [
                    {key: item[key] for key in ("path", "sha256", "bytes")}
                    for item in files
                ],
            }
        )
    resolved.sort(key=lambda item: (item["slug"], item["skillId"]))
    if agent.get("executorKind") == "kimi":
        kimi_resolved = []
        names = set()
        for item in resolved:
            name_key = item["_catalogName"].casefold()
            if name_key in names:
                skipped.append(
                    _skipped(item["skillId"], item.get("slug"), "name-conflict")
                )
                continue
            names.add(name_key)
            kimi_resolved.append(item)
        resolved = kimi_resolved
    for item in resolved:
        item.pop("_catalogName", None)
    skipped.sort(
        key=lambda item: (item.get("slug") or "", item["skillId"], item["reason"])
    )
    return {**_empty_bundle(), "skills": resolved}, skipped


def _empty_bundle() -> dict[str, Any]:
    return {"contract": dict(EMPTY_SKILL_BUNDLE["contract"]), "skills": []}


def _skipped(skill_id: str, slug: str | None, reason: str) -> dict[str, Any]:
    return {"skillId": skill_id, **({"slug": slug} if slug else {}), "reason": reason}
