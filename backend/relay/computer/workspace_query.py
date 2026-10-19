"""In-memory request/response broker for daemon workspace commands."""

from __future__ import annotations

import asyncio
from typing import Any

WORKSPACE_COMMAND_TIMEOUT_SECONDS = 10.0


class WorkspaceQueryBroker:
    def __init__(self) -> None:
        self._pending: dict[str, tuple[str, asyncio.Future[dict[str, Any]]]] = {}

    def register(self, command_id: str, sandbox_id: str) -> asyncio.Future[dict[str, Any]]:
        future: asyncio.Future[dict[str, Any]] = asyncio.get_running_loop().create_future()
        self._pending[command_id] = (sandbox_id, future)
        return future

    def resolve(self, command_id: str, sandbox_id: str, payload: dict[str, Any]) -> bool:
        pending = self._pending.get(command_id)
        if pending is None or pending[0] != sandbox_id:
            return False
        del self._pending[command_id]
        if not pending[1].done():
            pending[1].set_result(payload)
        return True

    def discard(self, command_id: str) -> None:
        self._pending.pop(command_id, None)
