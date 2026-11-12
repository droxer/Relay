"""Publish discovered repository Skills with per-directory validation results."""

from __future__ import annotations

from typing import Any

from .rules import SkillValidationError, _namespace, _validate_files


def publish_repository(
    ctx: Any, user_id: str, source: dict[str, Any],
    metadata: dict[str, Any], bundles: list[dict[str, Any]],
) -> dict[str, Any]:
    namespace = _namespace(metadata.get("namespace"))
    visibility = metadata.get("visibility", "private")
    if visibility not in ("private", "public"):
        raise SkillValidationError("invalid-visibility")
    payloads = []
    failed = []
    for bundle in bundles:
        subpath = bundle["subpath"]
        if bundle.get("error"):
            failed.append({"subpath": subpath, "code": bundle["error"]})
            continue
        try:
            files, manifest = _validate_files(bundle["files"])
        except SkillValidationError as error:
            failed.append({"subpath": subpath, "code": error.code})
            continue
        payloads.append({
            "name": manifest["name"], "namespace": namespace, "visibility": visibility,
            "source": "git", "sourceRef": {**source, "subpath": subpath},
            "files": files, "ownerHandle": user_id,
        })
    created, conflicts = ctx.skill_store.create_skills(user_id, payloads)
    failed.extend({"subpath": payloads[index]["sourceRef"]["subpath"], "code": code} for index, code in conflicts)
    return {"skills": created, "failed": sorted(failed, key=lambda item: item["subpath"])}
