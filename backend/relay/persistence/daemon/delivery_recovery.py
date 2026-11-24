"""Redeliver unacknowledged starts without changing execution ownership."""
from datetime import timedelta
from typing import Any
from sqlalchemy import select, update
from ...core.ids import now_iso
from ..engine import store_transaction
from ..db_time import require_db_time
from .rows import lease_expires_at, row_to_command
from .state import DaemonStoreState


class DeliveryRecoveryRows(DaemonStoreState):
    def recover_start_deliveries(self, node_id: str, *, limit: int, lease_seconds: float) -> list[dict[str, Any]]:
        if limit <= 0:
            return []
        now = now_iso()
        attempted_at = require_db_time(now)
        retry_before = attempted_at - timedelta(seconds=min(5, lease_seconds / 3))
        commands, requests = self.commands, self.run_requests
        stopping = select(requests.c.id).where(
            requests.c.current_command_id == commands.c.id,
            requests.c.state['_relay_stop_command_id'].as_string().is_not(None),
        ).correlate(commands).exists()
        expiry = lease_expires_at(now, lease_seconds)
        with store_transaction(self.engine) as conn:
            rows = conn.execute(select(commands).where(
                commands.c.node_id == node_id,
                commands.c.type == 'run.start',
                commands.c.status == 'dispatched',
                commands.c.updated_at <= retry_before,
                commands.c.command['_deliveryAcknowledged'].as_boolean().is_not(True),
                ~stopping,
            ).order_by(commands.c.created_at, commands.c.id).limit(limit).with_for_update()).mappings().all()
            if not rows:
                return []
            # Check again with a fresh snapshot after taking the command locks.
            # Another replica may have recorded a stop while a lock was held.
            renewed = set(conn.scalars(update(commands)
                .where(commands.c.id.in_([row['id'] for row in rows]), ~stopping)
                .values(updated_at=attempted_at, lease_expires_at=require_db_time(expiry))
                .returning(commands.c.id)))
        return [{**row_to_command(row), 'leaseExpiresAt': expiry} for row in rows if row['id'] in renewed]
