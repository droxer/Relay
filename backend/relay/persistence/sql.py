"""SQLAlchemy metadata and column helpers shared by every table definition.

Kept free of store logic so `relay.persistence.tables` can declare the whole
schema without importing any store, and stores can import the tables without a
cycle.
"""

from __future__ import annotations

from typing import Any

from sqlalchemy import JSON, Column, MetaData, Text, Uuid
from sqlalchemy.dialects.postgresql import JSONB

from ..core.ids import new_database_id

# Every database-backed store registers its tables here. One MetaData is what
# lets foreign keys cross aggregate boundaries (agents -> users, placements
# -> daemon_nodes) and lets `tests/unit/test_schema_drift.py` compare the
# migrated schema against the declared one.
#
# Snapshot convention: stores that keep a `snapshot` JSON column treat it as the
# authoritative record. Sibling columns (display_name, executor_kind, status, …)
# are derived projections used only for filtering, ordering, and uniqueness;
# they are rewritten from the snapshot on every write. A migration that edits a
# snapshot must update the derived columns in the same statement.
metadata = MetaData()


def entity_uuid_type() -> Any:
    """Native UUID in PostgreSQL, with TEXT retained for SQLite test stores."""
    return Uuid(as_uuid=False).with_variant(Text(), "sqlite")


def json_type() -> Any:
    """JSONB in PostgreSQL, plain JSON for SQLite test stores.

    Migrations have always created `jsonb`; declaring bare `JSON` here made
    `create_all` produce `json` columns instead, which sort and index
    differently.
    """
    return JSON().with_variant(JSONB(), "postgresql")


def database_id_column() -> Column[Any]:
    return Column("id", entity_uuid_type(), primary_key=True, default=new_database_id)
