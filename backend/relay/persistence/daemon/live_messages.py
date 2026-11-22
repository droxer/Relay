"""Settling `run.steer` commands once their daemon has answered.

A mixin of ``DatabaseDaemonStore``; it shares the store's engine and tables
(declared on ``DaemonStoreState``) and is not used on its own.
"""

from __future__ import annotations

from typing import Any

from sqlalchemy import select, update

from ...core.ids import now_iso
from ..db_time import require_db_time
from ..engine import store_transaction
from .rows import row_to_command
from .state import DaemonStoreState


class LiveMessageCommandRows(DaemonStoreState):
    def complete_live_message_command(self, node_id: str, command_id: str) -> dict[str, Any] | None:
        """Mark a `run.steer` command answered and return it.

        None means there is nothing left to settle: the answer was already
        taken (a redelivered `run.steered`), or the command never reached the
        daemon. Only the node the command was queued for may answer it.
        """
        with store_transaction(self.engine) as conn:
            row = (
                conn.execute(select(self.commands).where(self.commands.c.id == command_id).with_for_update())
                .mappings()
                .first()
            )
            if not row:
                raise KeyError(command_id)
            record = row_to_command(row)
            if record.get("nodeId") != node_id:
                raise PermissionError("Live message command belongs to a different daemon node.")
            if record["command"].get("type") != "run.steer":
                raise ValueError("Command is not a live message.")
            if record.get("status") != "dispatched":
                return None
            now = require_db_time(now_iso())
            conn.execute(
                update(self.commands)
                .where(self.commands.c.id == row["id"])
                .values(status="completed", updated_at=now, completed_at=now)
            )
            return record
