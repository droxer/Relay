"""Admin browsing of a Computer's workspace storage root through live reads.

The node root is an administrative storage container for Thread workspaces,
not a workspace shared across Threads or owned by an Agent. It only exists on
a live daemon that advertises ``workspace-read-shared``; there is no snapshot
fallback here — Thread artifacts remain the durable record.
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, HTTPException, Request

from ...core.ids import new_database_id
from ...security.request_auth import require_admin_session
from ..deps import AppContext, AppContextDep
from .workspace_transport import (
    dispatch_workspace_command,
    live_workspace_file,
    live_workspace_listing,
    raise_workspace_error,
    workspace_path,
)
from ...core.daemon_capabilities import DAEMON_CAPABILITY_WORKSPACE_READ_SHARED, has_capability

router = APIRouter()


def _shared_capable_node(ctx: AppContext, node_id: str) -> dict[str, Any]:
    node = next(
        (item for item in ctx.registry.monitor_nodes() if item["id"] == node_id), None
    )
    if node is None:
        raise HTTPException(404, "Daemon node not found.")
    if not node.get("online") or not has_capability(node, DAEMON_CAPABILITY_WORKSPACE_READ_SHARED):
        raise HTTPException(503, {"reason": "placement-unavailable"})
    return node


@router.get("/admin/daemon-nodes/{node_id}/workspace/files")
async def node_workspace_files(
    node_id: str, request: Request, ctx: AppContextDep
) -> dict[str, Any]:
    require_admin_session(request, ctx.auth_store)
    path = workspace_path(request.query_params.get("path"))
    node = _shared_capable_node(ctx, node_id)
    event = await dispatch_workspace_command(
        ctx,
        node,
        {
            "id": new_database_id(),
            "type": "workspace.list",
            "path": path,
        },
    )
    raise_workspace_error(event)
    return live_workspace_listing(
        event,
        path=path,
        metadata={"nodeId": node["id"], "scope": "shared"},
    )


@router.get("/admin/daemon-nodes/{node_id}/workspace/file")
async def node_workspace_file(
    node_id: str, request: Request, ctx: AppContextDep
) -> dict[str, Any]:
    require_admin_session(request, ctx.auth_store)
    path = workspace_path(request.query_params.get("path"), required=True)
    node = _shared_capable_node(ctx, node_id)
    event = await dispatch_workspace_command(
        ctx,
        node,
        {
            "id": new_database_id(),
            "type": "workspace.read",
            "path": path,
        },
    )
    raise_workspace_error(event)
    return live_workspace_file(
        event,
        path=path,
        metadata={"nodeId": node["id"], "scope": "shared"},
    )
