"""Linking an existing directory on a computer as a project's workspace.

The backend only relays the request: the daemon on that computer decides
whether the directory may be used (its allowed roots never leave the machine),
and answers with the directory's canonical path. See `project-links.ts`.
"""

from __future__ import annotations

import re
from typing import Any

from fastapi import HTTPException
from loguru import logger
from starlette.concurrency import run_in_threadpool

from ..core.computer_identity import computer_id
from ..core.ids import new_database_id
from ..core.daemon_capabilities import (
    DAEMON_CAPABILITY_PROJECT_LINKS,
    has_capability,
)
from ..core.workspace_layout import LINKED_WORKSPACE_PREFIX
from .deps import AppContext
from .workspace_transport import dispatch_workspace_command

WORKSPACE_HOST_PATH_MAX_LENGTH = 4096
# POSIX absolute, or a Windows drive path; the daemon re-validates either way.
_ABSOLUTE_HOST_PATH = re.compile(r"^(/|[A-Za-z]:[\\/])")


def requested_host_path(body: dict[str, Any]) -> str | None:
    """The optional `workspaceHostPath` of a create or check request."""
    value = body.get("workspaceHostPath")
    if value is None:
        return None
    if not isinstance(value, str):
        raise HTTPException(400, "project_workspace_path_invalid")
    path = value.strip()
    if not path:
        return None
    if (
        len(path) > WORKSPACE_HOST_PATH_MAX_LENGTH
        or "\x00" in path
        or not _ABSOLUTE_HOST_PATH.match(path)
    ):
        raise HTTPException(400, "project_workspace_path_invalid")
    return path


def new_linked_workspace_subpath() -> str:
    return f"{LINKED_WORKSPACE_PREFIX}{new_database_id()}"


def _live_link_nodes(
    nodes: list[dict[str, Any]], target_computer_id: str
) -> list[dict[str, Any]]:
    return [
        node
        for node in nodes
        if computer_id(node) == target_computer_id
        and node.get("online")
        and not node.get("stale")
        and not node.get("retiredAt")
        and has_capability(node, DAEMON_CAPABILITY_PROJECT_LINKS)
    ]


def _link_command(
    workspace_subpath: str, host_path: str, *, dry_run: bool
) -> dict[str, Any]:
    return {
        "id": new_database_id(),
        "type": "workspace.link",
        "workspaceSubpath": workspace_subpath,
        "hostPath": host_path,
        **({"dryRun": True} if dry_run else {}),
    }


def _refusal(event: dict[str, Any]) -> HTTPException:
    code = str(event.get("code") or "io-error").replace("-", "_")
    return HTTPException(
        422,
        {
            "code": f"project_workspace_{code}",
            "message": event.get("message") or "The computer refused this directory.",
        },
    )


async def link_existing_directory(
    ctx: AppContext,
    *,
    owner_user_id: str,
    node_id: Any,
    host_path: str,
    workspace_subpath: str,
    dry_run: bool = False,
) -> str:
    """Ask the selected computer to validate (and unless `dry_run`, link) a
    directory; returns its canonical path or raises the daemon's refusal."""
    node = (
        await run_in_threadpool(ctx.registry.get, node_id)
        if isinstance(node_id, str) and node_id
        else None
    )
    if not node or node.get("retiredAt"):
        raise HTTPException(400, "project_computer_not_found")
    if node.get("userId") != owner_user_id:
        raise HTTPException(400, "project_computer_forbidden")
    live = _live_link_nodes(
        await run_in_threadpool(ctx.registry.monitor_nodes), computer_id(node)
    )
    target = next((item for item in live if item["id"] == node["id"]), None)
    if target is None:
        if not has_capability(node, DAEMON_CAPABILITY_PROJECT_LINKS):
            raise HTTPException(409, "project_workspace_link_unsupported")
        raise HTTPException(409, "project_computer_offline")
    event = await dispatch_workspace_command(
        ctx, target, _link_command(workspace_subpath, host_path, dry_run=dry_run)
    )
    if event.get("type") != "workspace.linked":
        raise _refusal(event)
    canonical = event["hostPath"]
    if not dry_run:
        # Another daemon serving the same computer learns the link now rather
        # than at its next registration; a refusal there fails only its runs.
        for sibling in live:
            if sibling["id"] == target["id"]:
                continue
            try:
                await run_in_threadpool(
                    ctx.registry.enqueue,
                    sibling["id"],
                    _link_command(workspace_subpath, canonical, dry_run=False),
                )
            except ValueError as error:
                # The link already exists on the selected node; this sibling
                # still learns it at its next registration.
                logger.warning(
                    "Linked project directory not queued for sibling daemon",
                    sandbox_id=sibling["id"],
                    error=str(error),
                )
    return canonical


def registration_project_links(
    ctx: AppContext, sandbox: dict[str, Any], capabilities: list[str]
) -> dict[str, Any]:
    """The `projectLinks` a registering daemon replaces its link map with."""
    if DAEMON_CAPABILITY_PROJECT_LINKS not in capabilities:
        return {}
    project_store = getattr(ctx, "project_store", None)
    if project_store is None:
        return {}
    return {"projectLinks": project_store.list_linked_workspaces(computer_id(sandbox))}
