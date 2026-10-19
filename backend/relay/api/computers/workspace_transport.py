"""Shared transport helpers for live daemon workspace reads."""

from __future__ import annotations

import asyncio
import base64
from datetime import datetime, UTC
from typing import Any

from fastapi import HTTPException
from starlette.concurrency import run_in_threadpool

from ...core.computer_identity import computer_id
from ...realtime.event_notifier import workspace_response_key
from ...core.workspace_capabilities import required_workspace_capabilities
from ...computer.workspace_query import WORKSPACE_COMMAND_TIMEOUT_SECONDS
from ..deps import AppContext
from ...core.daemon_capabilities import (
    DAEMON_CAPABILITY_WORKSPACE_READ_SHARED,
    has_capability,
)

WORKSPACE_FILE_PREVIEW_LIMIT = 256 * 1024


def workspace_timestamp() -> str:
    return datetime.now(UTC).isoformat().replace("+00:00", "Z")


def workspace_path(raw: str | None, *, required: bool = False) -> str:
    requested = (raw or "").strip()
    if requested.startswith("/") or ".." in requested.split("/"):
        raise HTTPException(
            400, "Workspace path must be relative and must not traverse upward."
        )
    value = requested.strip("/")
    if required and not value:
        raise HTTPException(400, "Workspace file path is required.")
    return value


def workspace_binding_target(
    nodes: list[dict[str, Any]], binding: dict[str, Any]
) -> tuple[dict[str, Any], str, str]:
    """The live node that can read a recorded workspace binding, with the
    layout and subpath its `workspace.*` command carries."""
    candidates = [
        node
        for node in nodes
        if computer_id(node) == binding["computerId"]
        and node.get("online")
        and not node.get("stale")
        and not node.get("retiredAt")
    ]
    if not candidates:
        raise HTTPException(
            503, {"reason": "computer-offline", "code": "computer-offline"}
        )
    if binding.get("workspaceRoot"):
        candidates = [
            node
            for node in candidates
            if node.get("workspacePath") == binding["workspaceRoot"]
        ]
        if not candidates:
            raise HTTPException(
                503,
                {"reason": "placement-unavailable", "code": "placement-unavailable"},
            )
    layout = binding["layout"]
    required = (
        ("thread-workspaces",)
        if layout == "thread"
        else required_workspace_capabilities(layout, binding.get("subpath"))
    )
    node = next(
        (
            node
            for node in candidates
            if has_capability(node, DAEMON_CAPABILITY_WORKSPACE_READ_SHARED)
            and all(
                has_capability(node, capability)
                for capability in required
            )
        ),
        None,
    )
    if not node:
        raise HTTPException(
            503, {"reason": "workspace-unsupported", "code": "workspace-unsupported"}
        )
    subpath = (
        binding.get("subpath")
        if layout in ("task", "project")
        else binding.get("sessionId")
    )
    if not isinstance(subpath, str) or not subpath:
        raise HTTPException(
            503, {"reason": "placement-unavailable", "code": "placement-unavailable"}
        )
    return node, layout, subpath


def workspace_binding_command(
    *,
    routing_id: str,
    command_id: str,
    command_type: str,
    path: str,
    workspace_layout: str,
    workspace_subpath: str,
) -> dict[str, Any]:
    return {
        "id": command_id,
        "type": command_type,
        "sessionId": routing_id
        if workspace_layout in ("task", "project")
        else workspace_subpath,
        "workspaceLayout": workspace_layout,
        "workspaceSubpath": workspace_subpath,
        "path": path,
    }


async def dispatch_workspace_command(
    ctx: AppContext, node: dict[str, Any], command: dict[str, Any]
) -> dict[str, Any]:
    key = workspace_response_key(command["id"])
    deadline = asyncio.get_running_loop().time() + WORKSPACE_COMMAND_TIMEOUT_SECONDS
    enqueued = False
    while True:
        with ctx.control_plane_notifier.observe(key) as observed_version:
            if not enqueued:
                try:
                    await run_in_threadpool(ctx.registry.enqueue, node["id"], command)
                except ValueError as error:
                    raise HTTPException(
                        503, {"reason": "placement-overloaded", "detail": str(error)}
                    ) from error
                enqueued = True
            response = await run_in_threadpool(
                ctx.daemon_store.get_workspace_response, command["id"]
            )
            if response is not None:
                return response
            remaining = deadline - asyncio.get_running_loop().time()
            if remaining <= 0:
                raise HTTPException(503, {"reason": "placement-unavailable"})
            await ctx.control_plane_notifier.wait(
                key, observed_version, timeout=remaining
            )


def raise_workspace_error(event: dict[str, Any]) -> None:
    if event.get("type") != "workspace.error":
        return
    messages: dict[str | None, tuple[int, str]] = {
        "not-found": (404, "Workspace file path was not found."),
        "is-directory": (400, "Workspace file path is a directory."),
        "invalid-path": (400, "Workspace path is invalid."),
    }
    status, message = messages.get(
        event.get("code"), (502, event.get("message") or "Workspace read failed.")
    )
    raise HTTPException(status, message)


def live_workspace_listing(
    event: dict[str, Any], *, path: str, metadata: dict[str, Any]
) -> dict[str, Any]:
    return {
        **metadata,
        "source": "live",
        "path": event.get("path", path),
        "exists": bool(event.get("exists")),
        "entries": event.get("entries") or [],
        "generatedAt": workspace_timestamp(),
    }


def live_workspace_file(
    event: dict[str, Any], *, path: str, metadata: dict[str, Any]
) -> dict[str, Any]:
    raw = event.get("contentBase64")
    is_binary = bool(event.get("isBinary"))
    content = (
        None
        if is_binary
        else base64.b64decode(raw).decode("utf-8", errors="replace")
        if isinstance(raw, str)
        else None
    )
    return {
        **metadata,
        "source": "live",
        "path": event.get("path", path),
        "exists": True,
        "isBinary": is_binary,
        "bytes": event.get("bytes") or 0,
        "content": content,
        "contentBase64": raw if is_binary and isinstance(raw, str) else None,
        "truncated": bool(event.get("truncated")),
        "limitBytes": WORKSPACE_FILE_PREVIEW_LIMIT,
        "generatedAt": workspace_timestamp(),
    }
