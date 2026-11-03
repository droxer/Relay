"""Private image uploads, staged before a Thread exists."""

from sqlalchemy import BigInteger, Column, DateTime, ForeignKey, Index, Table, Text
from ..sql import database_id_column, entity_uuid_type, metadata

attachments = Table(
    "thread_attachments",
    metadata,
    database_id_column(),
    Column("owner_user_id", Text, nullable=False),
    Column("session_id", entity_uuid_type(), ForeignKey("sessions.id", ondelete="CASCADE")),
    Column("media_type", Text, nullable=False),
    Column("byte_size", BigInteger, nullable=False),
    Column("sha256", Text, nullable=False),
    Column("blob_key", Text),
    Column("content", Text),
    Column("created_at", DateTime(timezone=True), nullable=False),
    Index("ix_thread_attachments_session", "session_id"),
    Index("ix_thread_attachments_created", "created_at"),
)
