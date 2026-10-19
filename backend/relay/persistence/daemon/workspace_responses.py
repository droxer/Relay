"""Responses to workspace browse/read commands, kept for the request waiting on them.

A mixin of ``DatabaseDaemonStore``; it shares the store's engine and tables
(declared on ``DaemonStoreState``) and is not used on its own.
"""

from __future__ import annotations

from typing import Any
from sqlalchemy import (
    select,
    update,
)
from ..db_time import require_db_time
from ..events import daemon_event
from ...core.ids import now_iso
from ..engine import publish_database_notification, store_transaction
from .rows import (
    row_to_command,
)
from .state import DaemonStoreState


class WorkspaceResponseRows(DaemonStoreState):
    def record_workspace_response(self, node_id: str, response: dict[str, Any]) -> None:
        command_id = str(response["commandId"])
        with store_transaction(self.engine) as conn:
            row = (
                conn.execute(
                    select(self.commands)
                    .where(self.commands.c.id == command_id)
                    .with_for_update()
                )
                .mappings()
                .first()
            )
            if not row:
                raise KeyError(command_id)
            command = row_to_command(row)
            if command.get("nodeId") != node_id:
                raise PermissionError(
                    "Workspace command belongs to a different daemon node."
                )
            if not str(command["command"].get("type") or "").startswith("workspace."):
                raise ValueError("Command is not a workspace query.")
            if command.get("status") == "completed":
                if self.get_workspace_response(command_id) == response:
                    return
                raise ValueError("Workspace command already has a different response.")
            if command.get("status") != "dispatched":
                raise ValueError("Workspace command is not actively dispatched.")
            now = require_db_time(now_iso())
            conn.execute(
                update(self.commands)
                .where(self.commands.c.id == row["id"])
                .values(status="completed", updated_at=now, completed_at=now)
            )
            self._append_daemon_event(
                conn,
                daemon_event(
                    "daemon.workspace.response",
                    {
                        "nodeId": node_id,
                        "commandId": command_id,
                        "response": response,
                    },
                ),
            )
            publish_database_notification(
                conn,
                self.engine,
                self._workspace_changes.database_channel,
                f"workspace:{command_id}",
            )
        self._notify_workspace(command_id)

    def get_workspace_response(self, command_id: str) -> dict[str, Any] | None:
        with store_transaction(self.engine) as conn:
            row = (
                conn.execute(
                    select(self.events.c.payload)
                    .where(self.events.c.command_id == command_id)
                    .where(self.events.c.type == "daemon.workspace.response")
                    .order_by(self.events.c.timestamp.desc())
                    .limit(1)
                )
                .mappings()
                .first()
            )
        response = (row or {}).get("payload", {}).get("response")
        return response if isinstance(response, dict) else None
