"""Table definitions for persistence/org_settings_store."""

from __future__ import annotations

from sqlalchemy import (
    CheckConstraint,
    Column,
    DateTime,
    Integer,
    Table,
    Text,
)
from ..sql import json_type, metadata
from ...core.org_policy import DEFAULT_MAX_TASK_ROUNDS


settings = Table(
    "org_settings",
    metadata,
    Column("id", Text, primary_key=True),
    Column(
        "max_local_computers_per_user",
        Integer,
        nullable=False,
    ),
    Column(
        "max_task_rounds",
        Integer,
        nullable=False,
        server_default=str(DEFAULT_MAX_TASK_ROUNDS),
    ),
    Column("created_at", DateTime(timezone=True), nullable=False),
    Column("updated_at", DateTime(timezone=True), nullable=False),
    Column("skill_import_allowed_hosts", json_type(), nullable=False, server_default='["github.com"]'),
    CheckConstraint(
        "max_task_rounds >= 1",
        name="ck_org_settings_max_task_rounds_positive",
    ),
    CheckConstraint(
        "max_local_computers_per_user >= 0",
        name="ck_org_settings_max_local_computers_non_negative",
    ),
)
