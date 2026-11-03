"""Only encrypted credential envelopes ever enter this store."""

import hashlib
import time
from typing import Any

from sqlalchemy import delete, insert, select

from ..engine import create_all_tables, shared_engine, store_transaction
from ..resource_lock import resource_transaction
from ..tables.github import connections, states


class DatabaseGitHubConnectionStore:
    def __init__(self, database_url: str):
        self.engine = shared_engine(database_url)
        self.connections = connections
        if database_url.startswith("sqlite"):
            create_all_tables(self.engine)

    def lock(self, account_id: str) -> Any:
        return resource_transaction(self.engine, f"github-connection:{account_id}")

    def read_connection(self, account_id: str) -> str | None:
        with store_transaction(self.engine) as conn:
            return conn.scalar(select(connections.c.sealed_secret).where(connections.c.account_id == account_id))

    def save_connection(self, account_id: str, sealed: str) -> None:
        with store_transaction(self.engine) as conn:
            conn.execute(delete(connections).where(connections.c.account_id == account_id))
            conn.execute(insert(connections).values(account_id=account_id, sealed_secret=sealed))

    def issue_state(self, account_id: str, state: str, sealed: str) -> None:
        with store_transaction(self.engine) as conn:
            conn.execute(delete(states).where(states.c.expires_at <= time.time()))
            conn.execute(delete(states).where(states.c.account_id == account_id))
            conn.execute(insert(states).values(account_id=account_id, state_hash=_digest(state),
                sealed_secret=sealed, expires_at=time.time() + 600))

    def consume_state(self, account_id: str, state: str) -> str | None:
        with store_transaction(self.engine) as conn:
            return conn.scalar(delete(states).where(states.c.account_id == account_id,
                states.c.state_hash == _digest(state), states.c.expires_at > time.time()).returning(states.c.sealed_secret))

    def disconnect(self, account_id: str) -> None:
        with self.lock(account_id) as conn:
            conn.execute(delete(connections).where(connections.c.account_id == account_id))
            conn.execute(delete(states).where(states.c.account_id == account_id))


def _digest(value: str) -> str:
    return hashlib.sha256(value.encode()).hexdigest()
