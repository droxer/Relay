"""Daemon capabilities needed to interpret a durable workspace path."""

from ..persistence.project_store import LINKED_WORKSPACE_PREFIX


def required_workspace_capabilities(
    layout: str | None, subpath: str | None
) -> tuple[str, ...]:
    if layout == "project":
        if isinstance(subpath, str) and subpath.startswith(LINKED_WORKSPACE_PREFIX):
            return ("project-workspaces", "project-links")
        return ("project-workspaces",)
    if layout == "task":
        return ("task-workspaces",)
    return ()
