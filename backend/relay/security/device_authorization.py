"""Short-lived device grants. Only hashes of polling credentials are stored."""
from __future__ import annotations

from sqlalchemy import Column, DateTime, Index, Table, Text
from ..persistence.store_common import metadata

computer_authorizations = Table(
    "computer_authorizations", metadata,
    Column("device_hash", Text, primary_key=True),
    Column("user_code", Text, nullable=False, unique=True),
    Column("expires_at", DateTime(timezone=True), nullable=False),
    Column("status", Text, nullable=False),
    Column("workspace_path", Text, nullable=False),
    Column("display_name", Text, nullable=False),
    Column("node_id", Text, nullable=True),
    Column("employee_id", Text, nullable=True),
)
Index("ix_computer_authorizations_expires", computer_authorizations.c.expires_at)
