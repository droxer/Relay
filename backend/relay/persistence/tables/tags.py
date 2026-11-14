"""Table definitions for a person's saved tags (``persistence/task/tags.py``).

Tags on work stay in each Task and Automation snapshot; this table only keeps
the names a person saved, so a tag no record uses yet survives. ``name_key``
is the casefold identity ``core/task_tags`` gives a tag; ``name`` its
spelling.
"""

from __future__ import annotations

from sqlalchemy import Column, DateTime, ForeignKey, PrimaryKeyConstraint, Table, Text

from ..sql import entity_uuid_type, metadata

user_tags = Table(
    "user_tags",
    metadata,
    Column(
        "user_id",
        entity_uuid_type(),
        ForeignKey("users.id", ondelete="CASCADE", name="fk_user_tags_user"),
        nullable=False,
    ),
    Column("name_key", Text, nullable=False),
    Column("name", Text, nullable=False),
    Column("created_at", DateTime(timezone=True), nullable=False),
    PrimaryKeyConstraint("user_id", "name_key", name="pk_user_tags"),
)
