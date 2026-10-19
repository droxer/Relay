"""Whether a user may act on a project: the one ownership rule routes and
services share."""

from __future__ import annotations

from typing import Any

from .runtime import project_work_error


class ProjectAccessError(Exception):
    def __init__(self, status: int, detail: str) -> None:
        super().__init__(detail)
        self.status = status
        self.detail = detail


def project_for_owner(
    project_store: Any, project_id: str | None, owner_user_id: str | None, *, require_enabled: bool = False
) -> dict[str, Any] | None:
    """The live project ``owner_user_id`` owns, or ``ProjectAccessError``.

    404 for a missing or archived project, 403 for another user's, and 409
    with the work-error code when ``require_enabled`` and the project cannot
    take work."""
    if not project_id:
        return None
    project = project_store.get_project(project_id)
    if not project or project.get("archivedAt"):
        raise ProjectAccessError(404, "Project not found.")
    if project.get("ownerUserId") != owner_user_id:
        raise ProjectAccessError(403, "Project belongs to another user.")
    if require_enabled and (code := project_work_error(project)):
        raise ProjectAccessError(409, code)
    return project
