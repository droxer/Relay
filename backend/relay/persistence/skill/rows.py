"""Map skill, revision, and assignment records to and from table rows."""

from __future__ import annotations

from typing import Any

from ..db_time import format_db_time, parse_db_time


def _skill_row(skill: dict[str, Any], *, event_version: int) -> dict[str, Any]:
    return {
        "id": skill["id"],
        "owner_user_id": skill["ownerUserId"],
        "namespace_key": skill.get("namespace") or "",
        "name_key": skill["name"],
        "slug": skill["slug"],
        "visibility": skill["visibility"],
        "snapshot": skill,
        "event_version": event_version,
        "created_at": parse_db_time(skill["createdAt"]),
        "updated_at": parse_db_time(skill["updatedAt"]),
        "deleted_at": parse_db_time(skill.get("deletedAt")),
    }


def _revision_dict(row: Any) -> dict[str, Any]:
    return {
        "id": str(row["id"]),
        "skillId": str(row["skill_id"]),
        "revision": row["revision"],
        "manifestSha256": row["manifest_sha256"],
        "bytes": row["bytes"],
        "createdAt": format_db_time(row["created_at"]),
        "createdByUserId": str(row["created_by_user_id"]),
        "note": row["note"],
    }


def _assignment_row(assignment: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": assignment["id"],
        "skill_id": assignment["skillId"],
        "target_type": assignment["targetType"],
        "target_id": assignment["targetId"],
        "mode": assignment["mode"],
        "pin": assignment["pin"],
        "invocation": assignment["invocation"],
        "created_by_user_id": assignment["createdByUserId"],
        "created_at": parse_db_time(assignment["createdAt"]),
        "updated_at": parse_db_time(assignment["updatedAt"]),
    }


def _assignment_dict(row: Any) -> dict[str, Any]:
    return {
        "id": str(row["id"]),
        "skillId": str(row["skill_id"]),
        "targetType": row["target_type"],
        "targetId": row["target_id"],
        "mode": row["mode"],
        "pin": row["pin"],
        "invocation": row["invocation"],
        "createdByUserId": str(row["created_by_user_id"]),
        "createdAt": format_db_time(row["created_at"]),
        "updatedAt": format_db_time(row["updated_at"]),
    }
