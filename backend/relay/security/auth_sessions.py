"""Login sessions: issuing, looking up by token, and expiring them."""

from __future__ import annotations

from datetime import datetime, UTC
from typing import Any

from sqlalchemy import (
    delete,
    insert,
    select,
)

from .auth_cache import SESSION_ACCOUNTS
from .auth_rows import database_session_to_row, row_to_database_session
from .auth_state import AuthStoreState
from .credentials import hash_session_token, new_session_token
from ..core.ids import new_database_id
from ..persistence.db_time import format_db_time, parse_db_time
from ..persistence.engine import store_transaction


class AuthLoginSessions(AuthStoreState):
    def create_session(self, account_id: str) -> dict[str, Any]:
        token = new_session_token()
        now = datetime.now(UTC)
        expires_at = datetime.fromtimestamp(
            now.timestamp() + self.session_ttl_seconds, tz=UTC
        )
        session = {
            "id": new_database_id(),
            "token": token,
            "accountId": account_id,
            "createdAt": format_db_time(now),
            "expiresAt": format_db_time(expires_at),
        }
        with store_transaction(self.engine) as conn:
            conn.execute(
                insert(self.sessions).values(
                    **database_session_to_row(
                        session, account_pk=self._account_pk(conn, account_id)
                    )
                )
            )
        return session

    def get_session_by_token(self, token: str | None) -> dict[str, Any] | None:
        if not token:
            return None
        with store_transaction(self.engine) as conn:
            row = (
                conn.execute(
                    select(self.sessions).where(
                        self.sessions.c.token_hash == hash_session_token(token)
                    )
                )
                .mappings()
                .first()
            )
            if not row:
                return None
            session = row_to_database_session(row, token)
            expires_at = parse_db_time(session.get("expiresAt"))
            if expires_at and expires_at <= datetime.now(UTC):
                conn.execute(
                    delete(self.sessions).where(
                        self.sessions.c.token_hash == hash_session_token(token)
                    )
                )
                return None
        return session

    def delete_session(self, token: str) -> bool:
        token_hash = hash_session_token(token)
        with store_transaction(self.engine) as conn:
            result = conn.execute(
                delete(self.sessions).where(self.sessions.c.token_hash == token_hash)
            )
        SESSION_ACCOUNTS.invalidate_token(token_hash)
        return result.rowcount > 0

    def cleanup_expired_sessions(self) -> int:
        with store_transaction(self.engine) as conn:
            result = conn.execute(
                delete(self.sessions).where(
                    self.sessions.c.expires_at <= datetime.now(UTC)
                )
            )
        SESSION_ACCOUNTS.invalidate_all()
        return result.rowcount
