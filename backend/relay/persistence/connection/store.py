"""Transactional connection metadata; only encrypted secrets cross this boundary."""

import builtins
import hashlib
import time
from typing import Any

from sqlalchemy import delete, insert, select, update, func

from ...core.ids import new_database_id, now_iso
from ...core.connections import ConnectionError
from ..engine import create_all_tables, shared_engine, store_transaction
from ..resource_lock import resource_transaction
from ..tables.connections import connections, events, grants, states


class DatabaseConnectionStore:
    def __init__(self, database_url: str):
        self.engine = shared_engine(database_url)
        if database_url.startswith("sqlite"):
            create_all_tables(self.engine)

    def lock(self, key: str) -> Any:
        return resource_transaction(self.engine, f"service-connection:{key}")

    def _event(self, conn: Any, owner: str, aggregate: str, kind: str, data: dict[str, Any]) -> None:
        sequence = (conn.scalar(select(func.max(events.c.sequence)).where(events.c.aggregate_id == aggregate)) or 0) + 1
        conn.execute(insert(events).values(id=new_database_id(), owner_user_id=owner, aggregate_id=aggregate,
            sequence=sequence, record={"type": kind, "timestamp": now_iso(), **data}))

    def list(self, owner: str) -> builtins.list[dict[str, Any]]:
        with store_transaction(self.engine) as conn:
            return list(conn.scalars(select(connections.c.record).where(connections.c.owner_user_id == owner)))

    def get(self, owner: str, connection_id: str) -> dict[str, Any] | None:
        with store_transaction(self.engine) as conn:
            row = conn.execute(select(connections).where(connections.c.owner_user_id == owner,
                connections.c.id == connection_id)).mappings().first()
            return {**row["record"], "sealedSecret": row["sealed_secret"]} if row else None

    def save(self, owner: str, record: dict[str, Any], sealed: str | None) -> None:
        with self.lock(record["id"]) as conn:
            existing = self.get(owner, record["id"])
            values = dict(owner_user_id=owner, record=record, sealed_secret=sealed)
            if existing:
                conn.execute(update(connections).where(connections.c.id == record["id"],
                    connections.c.owner_user_id == owner).values(**values))
            else:
                conn.execute(insert(connections).values(id=record["id"], **values))
            self._event(conn, owner, record["id"], "connection.changed", record)

    def issue_state(self, owner: str, state: str, sealed: str) -> None:
        with store_transaction(self.engine) as conn:
            conn.execute(delete(states).where(states.c.expires_at <= time.time()))
            conn.execute(insert(states).values(state_hash=hashlib.sha256(state.encode()).hexdigest(),
                owner_user_id=owner, sealed_secret=sealed, expires_at=time.time() + 600))

    def consume_state(self, owner: str, state: str) -> str | None:
        with store_transaction(self.engine) as conn:
            return conn.scalar(delete(states).where(states.c.state_hash == hashlib.sha256(state.encode()).hexdigest(),
                states.c.owner_user_id == owner, states.c.expires_at > time.time()).returning(states.c.sealed_secret))

    def clear_authorizations(self, owner: str) -> None:
        with store_transaction(self.engine) as conn:
            conn.execute(delete(states).where(states.c.owner_user_id == owner))

    def grants(self, owner: str, target_type: str, target_id: str) -> builtins.list[dict[str, Any]]:
        with store_transaction(self.engine) as conn:
            return list(conn.scalars(select(grants.c.record).where(grants.c.owner_user_id == owner,
                grants.c.target_type == target_type, grants.c.target_id == target_id)))

    def grant(self, owner: str, grant_id: str) -> dict[str, Any] | None:
        with store_transaction(self.engine) as conn:
            return conn.scalar(select(grants.c.record).where(grants.c.owner_user_id == owner, grants.c.id == grant_id))

    def usage(self, owner: str, connection_id: str) -> builtins.list[dict[str, Any]]:
        with store_transaction(self.engine) as conn:
            rows = conn.execute(select(grants).where(grants.c.owner_user_id == owner)).mappings()
            return [{"targetType": row["target_type"], "targetId": row["target_id"]}
                for row in rows if row["record"]["connectionId"] == connection_id]

    def set_grants(self, owner: str, target_type: str, target_id: str, records: builtins.list[dict[str, Any]]) -> builtins.list[dict[str, Any]]:
        aggregate = f"{owner}:{target_type}:{target_id}"
        with self.lock(aggregate) as conn:
            old = {g["connectionId"]: g for g in self.grants(owner, target_type, target_id)}
            for record in records:
                prior = old.get(record["connectionId"], {})
                if "id" in record and (record["id"] != prior.get("id") or record["revision"] != prior.get("revision")):
                    raise ConnectionError("connection_grants_changed", 409)
            conn.execute(delete(grants).where(grants.c.owner_user_id == owner,
                grants.c.target_type == target_type, grants.c.target_id == target_id))
            saved = []
            for record in records:
                prior = old.get(record["connectionId"], {})
                same_access = prior and prior["resources"] == record["resources"] and prior["actions"] == record["actions"]
                item = prior if same_access else {**record, "id": new_database_id(), "revision": prior.get("revision", 0) + 1}
                conn.execute(insert(grants).values(id=item["id"], owner_user_id=owner, target_type=target_type,
                    target_id=target_id, record=item))
                saved.append(item)
            self._event(conn, owner, aggregate, "connection_grants.changed", {"grants": saved})
            return saved
