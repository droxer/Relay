"""Redeliver unacknowledged starts without changing execution ownership."""
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
        with store_transaction(self.engine) as conn:
            rows = conn.execute(select(self.commands).where(
                self.commands.c.node_id == node_id,
                self.commands.c.type == 'run.start',
                self.commands.c.status == 'dispatched',
                self.commands.c.command['_deliveryAcknowledged'].as_boolean().is_not(True),
            ).order_by(self.commands.c.created_at).limit(limit).with_for_update()).mappings().all()
            records = []
            for row in rows:
                record = row_to_command(row)
                stopping = conn.scalar(select(self.run_requests.c.id).where(self.run_requests.c.current_command_id == row['id'], self.run_requests.c.state['_relay_stop_command_id'].as_string().is_not(None)))
                if stopping:
                    continue
                expiry = lease_expires_at(now_iso(), lease_seconds)
                conn.execute(update(self.commands).where(self.commands.c.id == row['id']).values(lease_expires_at=require_db_time(expiry)))
                records.append({**record, 'leaseExpiresAt': expiry})
            return records
