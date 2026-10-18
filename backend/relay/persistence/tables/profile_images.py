"""Table definitions for persistence/profile_image_store."""

from __future__ import annotations

from sqlalchemy import Column, LargeBinary, Table, Text
from ..sql import metadata


images = Table(
    "profile_images",
    metadata,
    Column("kind", Text, primary_key=True),
    Column("entity_id", Text, primary_key=True),
    Column("content", LargeBinary, nullable=False),
    Column("content_type", Text, nullable=False),
    Column("etag", Text, nullable=False),
)
