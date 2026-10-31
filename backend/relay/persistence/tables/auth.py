"""Table definitions for security/auth."""

from __future__ import annotations

from sqlalchemy import (
    CheckConstraint,
    Column,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    Table,
    Text,
)
from ..sql import database_id_column, entity_uuid_type, json_type, metadata
from ...core.user_preferences import DEFAULT_USER_LANGUAGE, DEFAULT_USER_THEME


departments = Table(
    "departments",
    metadata,
    database_id_column(),
    Column("name", Text, nullable=False),
    Column(
        "parent_department_id",
        entity_uuid_type(),
        ForeignKey("departments.id", ondelete="SET NULL"),
        nullable=True,
    ),
    Column("created_at", DateTime(timezone=True), nullable=False),
    Column("updated_at", DateTime(timezone=True), nullable=False),
    Index("ix_departments_parent_department_id", "parent_department_id"),
)

users = Table(
    "users",
    metadata,
    database_id_column(),
    # The @handle. `id` is a UUID (uuid5 of the handle for anything created
    # through the admin form), which made the admin lists render `@<uuid>`
    # and left the handle grammar with nothing behind it. The handle is the
    # display and lookup identity; `id` stays the foreign key everywhere.
    Column("handle", Text, nullable=True),
    Column("display_name", Text, nullable=False),
    Column("email", Text, nullable=True),
    Column(
        "department_id",
        entity_uuid_type(),
        ForeignKey("departments.id", ondelete="SET NULL"),
        nullable=True,
    ),
    # Empty means "inherit the org-wide default" rather than "no
    # computers": a global change has to move every user who was never
    # pinned to a number of their own.
    Column("max_local_computers", Integer, nullable=True),
    Column("created_at", DateTime(timezone=True), nullable=False),
    Column("updated_at", DateTime(timezone=True), nullable=False),
    Column("deleted_at", DateTime(timezone=True), nullable=True),
    Index("ix_users_department_id", "department_id"),
    Index("uq_users_handle", "handle", unique=True),
)

accounts = Table(
    "auth_accounts",
    metadata,
    database_id_column(),
    Column("username", Text, nullable=False, unique=True),
    Column("email", Text, nullable=True),
    Column("role", Text, nullable=False),
    Column(
        "user_id",
        entity_uuid_type(),
        ForeignKey("users.id", ondelete="SET NULL"),
        nullable=True,
    ),
    Column("theme", Text, nullable=False, server_default=DEFAULT_USER_THEME),
    Column("language", Text, nullable=False, server_default=DEFAULT_USER_LANGUAGE),
    # The onboarding wizard's stored choices (security/onboarding.py);
    # NULL until the person first acts on the wizard.
    Column("onboarding", json_type(), nullable=True),
    # Home queue items the person snoozed (security/home_snoozes.py);
    # NULL until the first snooze.
    Column("home_snoozes", json_type(), nullable=True),
    Column("password_hash", Text, nullable=False),
    Column("created_at", DateTime(timezone=True), nullable=False),
    Column("updated_at", DateTime(timezone=True), nullable=False),
    CheckConstraint("role in ('admin', 'user')", name="ck_auth_accounts_role"),
    Index("ix_auth_accounts_role", "role"),
    Index("ix_auth_accounts_user_id", "user_id"),
)

sessions = Table(
    "auth_sessions",
    metadata,
    database_id_column(),
    Column("token_hash", Text, nullable=False, unique=True),
    Column(
        "account_id",
        entity_uuid_type(),
        ForeignKey("auth_accounts.id", ondelete="CASCADE"),
        nullable=False,
    ),
    Column("created_at", DateTime(timezone=True), nullable=False),
    Column("expires_at", DateTime(timezone=True), nullable=False),
    Index("ix_auth_sessions_account_id", "account_id"),
    Index("ix_auth_sessions_expires_at", "expires_at"),
)

# Single-use password reset links; only the token's SHA-256 is kept. The
# rules that read and write it live in `security/password_resets.py`.
password_resets = Table(
    "auth_password_resets",
    metadata,
    database_id_column(),
    Column(
        "account_id",
        entity_uuid_type(),
        ForeignKey("auth_accounts.id", ondelete="CASCADE"),
        nullable=False,
    ),
    Column("token_hash", Text, nullable=False, unique=True),
    Column("created_at", DateTime(timezone=True), nullable=False),
    Column("expires_at", DateTime(timezone=True), nullable=False),
    # Set when the link is redeemed or superseded by a newer one.
    Column("used_at", DateTime(timezone=True), nullable=True),
    Index("ix_auth_password_resets_account_id_created_at", "account_id", "created_at"),
    Index("ix_auth_password_resets_expires_at", "expires_at"),
)
