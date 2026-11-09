"""The latest transport diagnostic snapshot for each stable Computer."""
from typing import Any
from sqlalchemy import select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.dialects.sqlite import insert as sqlite_insert
from ..engine import store_transaction
from ..tables.daemon_reports import transport_state
from .state import DaemonStoreState


class TransportRows(DaemonStoreState):
    def transport_status(self, computer_id: str) -> dict[str, Any] | None:
        with store_transaction(self.engine) as conn:
            return conn.scalar(select(transport_state.c.snapshot).where(transport_state.c.computer_id == computer_id))

    def save_transport_status(self, computer_id: str, snapshot: dict[str, Any]) -> None:
        with store_transaction(self.engine) as conn:
            dialect_insert = pg_insert if conn.dialect.name == 'postgresql' else sqlite_insert
            statement = dialect_insert(transport_state).values(computer_id=computer_id, snapshot=snapshot)
            conn.execute(statement.on_conflict_do_update(index_elements=[transport_state.c.computer_id], set_={'snapshot': statement.excluded.snapshot}))
