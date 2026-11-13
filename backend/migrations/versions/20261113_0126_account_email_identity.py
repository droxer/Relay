"""Make an Account's email a unique, case-insensitive sign-in identifier.

Revision ID: 20261113_0126
Revises: 20261112_0125

Every new Account now carries a normalized email and may sign in with it. This
adds the unique index on ``lower(email)`` that keeps one address to one
Account. It changes no row: legacy Accounts keep a NULL email and their
username sign-in, and malformed or unnormalized legacy addresses stay as they
are. When two Accounts already share an address the upgrade stops before
touching the schema and names them (by id) for an operator to resolve; run
``relay audit-account-emails`` against a copy of production first.
"""
from __future__ import annotations

import logging

import sqlalchemy as sa
from alembic import op

from relay.ops.account_email_audit import audit_account_emails

revision = "20261113_0126"
down_revision = "20261112_0125"
branch_labels = None
depends_on = None

INDEX = "uq_auth_accounts_email_lower"
logger = logging.getLogger(__name__)


def upgrade() -> None:
    audit = audit_account_emails(op.get_bind())
    if audit.duplicate_emails:
        raise RuntimeError(f"0126: {audit.blocking_message()}")
    for note in audit.notes():
        logger.warning("0126: %s", note)
    op.create_index(INDEX, "auth_accounts", [sa.text("lower(email)")], unique=True)


def downgrade() -> None:
    op.drop_index(INDEX, table_name="auth_accounts")
