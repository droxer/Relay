"""The admin bearer token, kept as a hash.

A single row, database-only like org settings. The token is a standing admin
credential that no session revocation touches, so the database keeps only its
SHA-256: a dump or replica of the database never yields admin access. The
plaintext exists once — in the seed the operator chose, or in the reissue
response that shows it.
"""

from __future__ import annotations

import hashlib
import hmac
import secrets
from datetime import datetime, timezone

from sqlalchemy import Column, DateTime, Table, Text, insert, select, update
from sqlalchemy.exc import IntegrityError

from .store_common import create_all_tables, shared_engine, store_transaction
from .store_common import metadata as shared_metadata

ADMIN_TOKEN_ROW_ID = "admin"
_TOKEN_BYTES = 32


def hash_admin_token(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


class DatabaseAdminTokenStore:
    metadata = shared_metadata

    tokens = Table(
        "admin_tokens",
        metadata,
        Column("id", Text, primary_key=True),
        Column("token_hash", Text, nullable=False),
        Column("issued_at", DateTime(timezone=True), nullable=False),
    )

    def __init__(self, database_url: str, *, create_schema: bool = False):
        self.engine = shared_engine(database_url)
        if create_schema:
            create_all_tables(self.engine)

    def _stored_hash(self) -> str | None:
        with store_transaction(self.engine) as conn:
            return conn.scalar(
                select(self.tokens.c.token_hash).where(self.tokens.c.id == ADMIN_TOKEN_ROW_ID)
            )

    def is_configured(self) -> bool:
        return self._stored_hash() is not None

    def verify(self, candidate: str) -> bool:
        if not candidate:
            return False
        stored = self._stored_hash()
        return stored is not None and hmac.compare_digest(stored, hash_admin_token(candidate))

    def seed(self, token: str) -> bool:
        """Store ``token`` only if none is stored; True when it was stored."""
        try:
            with store_transaction(self.engine) as conn:
                if conn.scalar(select(self.tokens.c.id).where(self.tokens.c.id == ADMIN_TOKEN_ROW_ID)):
                    return False
                conn.execute(insert(self.tokens).values(**self._row(token)))
        except IntegrityError:
            # Another backend seeded first; its token stands.
            return False
        return True

    def issue(self) -> str:
        """Replace any stored token with a fresh one and return its plaintext."""
        token = secrets.token_urlsafe(_TOKEN_BYTES)
        row = self._row(token)
        with store_transaction(self.engine) as conn:
            updated = conn.execute(
                update(self.tokens).where(self.tokens.c.id == ADMIN_TOKEN_ROW_ID).values(**row)
            ).rowcount
            if not updated:
                conn.execute(insert(self.tokens).values(**row))
        return token

    @staticmethod
    def _row(token: str) -> dict[str, object]:
        return {
            "id": ADMIN_TOKEN_ROW_ID,
            "token_hash": hash_admin_token(token),
            "issued_at": datetime.now(timezone.utc),
        }
