"""Shared transport helpers for live daemon workspace reads."""

from __future__ import annotations

import asyncio
import base64
from collections.abc import Awaitable, Callable
from datetime import datetime, UTC
from typing import Any

from fastapi import HTTPException
from starlette.concurrency import run_in_threadpool

from ...core.computer_identity import computer_id
from ...realtime.event_notifier import workspace_response_key
from ...core.workspace_capabilities import required_workspace_capabilities
from ...core.workspace_layout import THREAD_RECORDS_DIR, THREAD_RECORDS_DIRS
from ..deps import AppContext
from ...core.daemon_capabilities import (
    DAEMON_CAPABILITY_WORKSPACE_LIST_THREAD_RECORDS,
    DAEMON_CAPABILITY_WORKSPACE_READ_SHARED,
    has_capability,
)

WORKSPACE_COMMAND_TIMEOUT_SECONDS = 10.0
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


async def workspace_listing_event(
    path: str, *, view: str | None, node: dict[str, Any], max_event_bytes: int,
    command_for: Callable[[str], dict[str, Any]],
    dispatch: Callable[[dict[str, Any]], Awaitable[dict[str, Any]]],
) -> dict[str, Any]:
    async def read(folder: str, *, merge: bool = False) -> dict[str, Any]:
        command = command_for(folder)
        if merge:
            command["threadRecordsMaxBytes"] = max_event_bytes
        event = await dispatch(command)
        raise_workspace_error(event)
        return event

    if view != "activity" or (path != THREAD_RECORDS_DIR and not path.startswith(f"{THREAD_RECORDS_DIR}/")):
        return await read(path)
    if ".." in path.replace("\\", "/").split("/"):
        raise HTTPException(400, "Workspace path must not traverse upward.")

    relative = path[len(THREAD_RECORDS_DIR):]
    legacy_paths = [f"{root}{relative}" for root in THREAD_RECORDS_DIRS[1:]]
    if has_capability(node, DAEMON_CAPABILITY_WORKSPACE_LIST_THREAD_RECORDS):
        current = await read(path, merge=True)
        if current.get("threadRecordsMerged") is True:
            return current
        # A large listing falls back to separate replies, as does a daemon downgraded during the read.
        older = await asyncio.gather(*(read(folder) for folder in legacy_paths))
    else:
        current, *older = await asyncio.gather(*(read(folder) for folder in [path, *legacy_paths]))

    entries = {
        entry["name"]: entry
        for listing in [*reversed(older), current]
        for entry in listing.get("entries", [])
        if isinstance(entry, dict) and isinstance(entry.get("name"), str)
    }
    return {
        **current, "threadRecordsMerged": True,
        "exists": any(listing.get("exists") for listing in [current, *older]),
        "entries": sorted(entries.values(), key=lambda entry: (entry.get("kind") != "directory", entry["name"].lower())),
    }


def live_workspace_listing(
    event: dict[str, Any], *, path: str, metadata: dict[str, Any]
) -> dict[str, Any]:
    return {
        **metadata,
        "source": "live",
        "path": event.get("path", path),
        "exists": bool(event.get("exists")),
        "entries": event.get("entries") or [],
        **({"threadRecordsMerged": True} if event.get("threadRecordsMerged") is True else {}),
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
