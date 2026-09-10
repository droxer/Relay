"""Resolve produced-file records against bounded live workspace listings."""

from __future__ import annotations

from posixpath import dirname
from typing import Any

from fastapi import HTTPException

PRODUCED_FILE_LISTING_MAX_DIRS = 8

LIVE_STATUS_BY_REASON = {
    "workspace-not-created": "not-created",
    "computer-offline": "offline",
    "workspace-unsupported": "unsupported",
}


def live_status(error: HTTPException) -> str:
    """Normalize daemon and placement failures into the client vocabulary."""
    if error.status_code == 403:
        return "denied"
    detail = error.detail if isinstance(error.detail, dict) else {}
    reason = detail.get("reason") or detail.get("code")
    return LIVE_STATUS_BY_REASON.get(reason, "unavailable")


def listing_directories(
    artifacts: list[dict[str, Any]],
    *,
    root: str = "",
    limit: int = PRODUCED_FILE_LISTING_MAX_DIRS,
) -> list[str]:
    """List the requested root, then the busiest produced-file directories."""
    counts: dict[str, int] = {}
    for artifact in artifacts:
        relative = artifact.get("workspaceRelativePath")
        if not isinstance(relative, str) or not relative:
            continue
        directory = dirname(relative)
        counts[directory] = counts.get(directory, 0) + 1
    ranked = sorted(counts.items(), key=lambda item: (-item[1], item[0]))
    directories = [root]
    for directory, _count in ranked:
        if len(directories) >= limit:
            break
        if directory not in directories:
            directories.append(directory)
    return directories


def file_currency(
    artifact: dict[str, Any], listings: dict[str, dict[str, dict[str, Any]]]
) -> str:
    """Return whether the live workspace copy still matches the record."""
    relative = artifact.get("workspaceRelativePath")
    if not isinstance(relative, str) or not relative:
        return "unknown"
    entries = listings.get(dirname(relative))
    if entries is None:
        return "unknown"
    entry = entries.get(relative.rsplit("/", 1)[-1])
    if entry is None:
        return "deleted"
    if entry.get("bytes") != artifact.get("bytes"):
        return "changed-since"
    updated_at = entry.get("updatedAt") or ""
    created_at = artifact.get("createdAt") or ""
    return "changed-since" if updated_at > created_at else "current"
