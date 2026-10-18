"""Daemon capabilities needed to interpret a durable workspace path."""

from __future__ import annotations

from ..core.daemon_capabilities import (
    DAEMON_CAPABILITY_PROJECT_LINKS,
    DAEMON_CAPABILITY_PROJECT_WORKSPACES,
    DAEMON_CAPABILITY_TASK_WORKSPACES,
)
from ..core.workspace_layout import LINKED_WORKSPACE_PREFIX


def required_workspace_capabilities(
    layout: str | None, subpath: str | None
) -> tuple[str, ...]:
    if layout == "project":
        if isinstance(subpath, str) and subpath.startswith(LINKED_WORKSPACE_PREFIX):
            return (DAEMON_CAPABILITY_PROJECT_WORKSPACES, DAEMON_CAPABILITY_PROJECT_LINKS)
        return (DAEMON_CAPABILITY_PROJECT_WORKSPACES,)
    if layout == "task":
        return (DAEMON_CAPABILITY_TASK_WORKSPACES,)
    return ()
