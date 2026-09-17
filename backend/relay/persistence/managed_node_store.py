"""Shared managed-node state using the existing lifecycle validation rules."""

from __future__ import annotations

from contextlib import contextmanager
from typing import Any, Iterator

from sqlalchemy import Column, Index, Table, Text, delete, insert, select, update

from ..services.managed_nodes import LocalManagedNodeStore
from .store_common import (
    create_all_tables,
    json_type,
    metadata,
    shared_engine,
    store_transaction,
)
from .resource_lock import resource_transaction


class DatabaseManagedNodeStore(LocalManagedNodeStore):
    records = Table(
        "managed_node_records",
        metadata,
        Column("kind", Text, primary_key=True),
        Column("id", Text, primary_key=True),
        Column("node_id", Text, nullable=True),
        Column("snapshot", json_type(), nullable=False),
        Index("ix_managed_node_records_kind_node", "kind", "node_id"),
    )

    def __init__(self, database_url: str, *, create_schema: bool = False):
        self.engine = shared_engine(database_url)
        if create_schema:
            create_all_tables(self.engine)

    @contextmanager
    def _policy_slot_lock(self) -> Iterator[None]:
        # Only desired-capacity changes contend on the policy lock. Progress,
        # attempts and enrollment use the owning node's lock instead.
        with resource_transaction(self.engine, "managed-policy"):
            yield

    @contextmanager
    def _mutation_scope(
        self,
        node_id: str | None = None,
        *,
        attempt_id: str | None = None,
        grant_id: str | None = None,
    ) -> Iterator[None]:
        if grant_id:
            grant = self._read_record("grants", grant_id)
            attempt_id = (grant or {}).get("attemptId")
        if attempt_id:
            attempt = self._read_record("attempts", attempt_id)
            node_id = (attempt or {}).get("managedNodeId")
        with resource_transaction(
            self.engine, f"managed-node:{node_id or grant_id or attempt_id or 'new'}"
        ):
            yield

    def _read_record(self, kind: str, record_id: str) -> dict[str, Any] | None:
        with store_transaction(self.engine) as conn:
            return conn.scalar(
                select(self.records.c.snapshot).where(
                    self.records.c.kind == kind, self.records.c.id == record_id
                )
            )

    def _write_record(self, kind: str, record: dict[str, Any]) -> None:
        node_id = record["id"] if kind == "nodes" else record.get("managedNodeId")
        if kind == "grants":
            attempt = self._read_record("attempts", record["attemptId"])
            node_id = (attempt or {}).get("managedNodeId")
        with store_transaction(self.engine) as conn:
            changed = conn.execute(
                update(self.records)
                .where(self.records.c.kind == kind, self.records.c.id == record["id"])
                .values(snapshot=record, node_id=node_id)
            ).rowcount
            if not changed:
                conn.execute(
                    insert(self.records).values(
                        kind=kind, id=record["id"], node_id=node_id, snapshot=record
                    )
                )

    def _delete_record(self, kind: str, record_id: str) -> None:
        with store_transaction(self.engine) as conn:
            conn.execute(
                delete(self.records).where(
                    self.records.c.kind == kind, self.records.c.id == record_id
                )
            )

    def _records(
        self, kind: str, *, node_id: str | None = None
    ) -> list[dict[str, Any]]:
        statement = select(self.records.c.snapshot).where(self.records.c.kind == kind)
        if node_id is not None:
            statement = statement.where(self.records.c.node_id == node_id)
        with store_transaction(self.engine) as conn:
            return list(conn.scalars(statement))

    def _sweep_grants(self, discarded_attempt_ids: set[str]) -> None:
        # Attempt history is bounded per node. Avoid scanning other nodes'
        # grants on every provisioning retry; expired grants are rejected at use.
        if not discarded_attempt_ids:
            return
        with store_transaction(self.engine) as conn:
            conn.execute(
                delete(self.records).where(
                    self.records.c.kind == "grants",
                    self.records.c.snapshot["attemptId"]
                    .as_string()
                    .in_(discarded_attempt_ids),
                )
            )
