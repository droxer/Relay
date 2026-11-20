"""The latest transport diagnostic snapshot for each stable Computer."""
from typing import Any
from sqlalchemy import BigInteger, cast, select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.dialects.sqlite import insert as sqlite_insert
from ..engine import store_transaction
from ..tables.daemon_reports import transport_state
from .state import DaemonStoreState


class TransportRows(DaemonStoreState):
    def transport_status(self, computer_id: str) -> dict[str, Any] | None:
        with store_transaction(self.engine) as conn:
            return conn.scalar(select(transport_state.c.snapshot).where(transport_state.c.computer_id == computer_id))

    def transport_summaries(self, computer_ids: set[str]) -> dict[str, dict[str, Any]]:
        if not computer_ids:
            return {}
        snapshot = transport_state.c.snapshot
        fields = [
            snapshot["state"].as_string().label("state"),
            snapshot["causes"].label("causes"),
            snapshot["recovered"].as_boolean().label("recovered"),
            cast(snapshot["pending"].as_string(), BigInteger).label("pending"),
            cast(snapshot["quarantined"].as_string(), BigInteger).label("quarantined"),
        ]
        with store_transaction(self.engine) as conn:
            rows = conn.execute(
                select(transport_state.c.computer_id, *fields).where(transport_state.c.computer_id.in_(computer_ids))
            ).mappings()
            return {
                row["computer_id"]: {key: row[key] for key in ("state", "causes", "recovered", "pending", "quarantined")
                                    if row[key] is not None}
                for row in rows
            }

    def save_transport_status(self, computer_id: str, snapshot: dict[str, Any]) -> None:
        with store_transaction(self.engine) as conn:
            dialect_insert = pg_insert if conn.dialect.name == 'postgresql' else sqlite_insert
            statement = dialect_insert(transport_state).values(computer_id=computer_id, snapshot=snapshot)
            conn.execute(statement.on_conflict_do_update(index_elements=[transport_state.c.computer_id], set_={'snapshot': statement.excluded.snapshot}))
