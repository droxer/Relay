"""Retired unscoped Computer storage reads.

A Computer can contain several Users' private work. Hardware administration
does not authorize reading that storage root, even for the Computer's owner.
File access goes through the owning Task, Thread, or Project routes instead.
Keep the legacy URLs registered so old clients receive an explicit refusal.
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, HTTPException, Request

from ...security.request_auth import require_admin_session
from ..deps import AppContextDep

router = APIRouter()


@router.get("/admin/daemon-nodes/{node_id}/workspace/files")
@router.get("/admin/daemon-nodes/{node_id}/workspace/file")
def node_workspace_read(
    node_id: str, request: Request, ctx: AppContextDep
) -> dict[str, Any]:
    require_admin_session(request, ctx.auth_store)
    raise HTTPException(
        403, "Open files through the owning task, thread, or project workspace."
    )
