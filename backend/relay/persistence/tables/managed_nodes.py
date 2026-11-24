"""Table definitions for persistence/managed_node_store."""

from __future__ import annotations

from sqlalchemy import Column, Index, Table, Text, literal_column, text
from ..sql import json_type, metadata


NODE_RECORD = "kind = 'nodes'"
DELETED_NODE_RECORD = (
    NODE_RECORD + " AND (snapshot ->> 'desiredState') = 'deleted' AND (snapshot ->> 'phase') = 'deleted'"
)
NODE_OWNER = "(snapshot ->> 'userId')"
NODE_DAEMON_ID = "(snapshot ->> 'activeDaemonNodeId')"
DELETED_NODE_TIME = "COALESCE(snapshot ->> 'updatedAt', snapshot ->> 'createdAt')"
LIVE_DAEMON_REFERENCE = NODE_RECORD + f" AND {NODE_DAEMON_ID} IS NOT NULL"

records = Table(
    "managed_node_records",
    metadata,
    Column("kind", Text, primary_key=True),
    Column("id", Text, primary_key=True),
    Column("node_id", Text, nullable=True),
    Column("snapshot", json_type(), nullable=False),
    Index("ix_managed_node_records_kind_node", "kind", "node_id"),
    Index("ix_managed_node_records_owner", literal_column(NODE_OWNER),
          postgresql_where=text(NODE_RECORD), sqlite_where=text(NODE_RECORD)),
    Index("ix_managed_node_records_daemon", literal_column(NODE_DAEMON_ID),
          postgresql_where=text(LIVE_DAEMON_REFERENCE), sqlite_where=text(LIVE_DAEMON_REFERENCE)),
    Index("ix_managed_node_records_deleted", literal_column(DELETED_NODE_TIME), "id",
          postgresql_where=text(DELETED_NODE_RECORD), sqlite_where=text(DELETED_NODE_RECORD)),
)
