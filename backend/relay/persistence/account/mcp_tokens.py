"""Issue once, authenticate by digest, list metadata, and revoke MCP tokens."""
from __future__ import annotations
from datetime import datetime, timedelta, UTC
import hashlib
import secrets
from typing import Any
from sqlalchemy import insert, select, update
from ...core.ids import new_database_id
from ..engine import store_transaction
from ..db_time import format_db_time
from ..sql import names_no_uuid_row
from ..tables.mcp import mcp_tokens


class DatabaseMcpTokenStore:
    def __init__(self, engine: Any):
        self.engine = engine

    def issue(self, owner: str, name: str, *, project_ids: list[str] | None = None,
              computer_id: str | None = None, command_id: str | None = None) -> dict[str, Any]:
        token = f"relay_mcp_{secrets.token_urlsafe(32)}"
        now = datetime.now(UTC)
        record = {"id": new_database_id(), "owner_user_id": owner, "name": name,
                  "token_hash": hashlib.sha256(token.encode()).hexdigest(), "computer_id": computer_id,
                  "project_ids": project_ids, "command_id": command_id, "created_at": now,
                  "expires_at": now + (timedelta(hours=24) if command_id else timedelta(days=90)), "revoked_at": None}
        with store_transaction(self.engine) as conn:
            conn.execute(insert(mcp_tokens).values(**record))
        return {**_public(record), "token": token}

    def authenticate(self, token: str | None) -> dict[str, Any] | None:
        if not token or not token.startswith("relay_mcp_") or len(token) > 128:
            return None
        with store_transaction(self.engine) as conn:
            row = conn.execute(select(mcp_tokens).where(
                mcp_tokens.c.token_hash == hashlib.sha256(token.encode()).hexdigest(),
                mcp_tokens.c.revoked_at.is_(None), mcp_tokens.c.expires_at > datetime.now(UTC),
            )).mappings().first()
        return {**_public(row), "commandId": row["command_id"]} if row else None

    def credential_status(self, token: str) -> dict[str, Any] | None:
        """Inspect expiry/revocation for an authenticated Computer's renewal."""
        if not token.startswith("relay_mcp_") or len(token) > 128:
            return None
        with store_transaction(self.engine) as conn:
            row = conn.execute(select(mcp_tokens).where(
                mcp_tokens.c.token_hash == hashlib.sha256(token.encode()).hexdigest(),
            ).with_for_update()).mappings().first()
        return {**_public(row), "commandId": row["command_id"]} if row else None

    def list_tokens(self, owner: str) -> list[dict[str, Any]]:
        with store_transaction(self.engine) as conn:
            rows = conn.execute(select(mcp_tokens).where(mcp_tokens.c.owner_user_id == owner,
                mcp_tokens.c.command_id.is_(None)).order_by(mcp_tokens.c.created_at.desc())).mappings().all()
        return [_public(row) for row in rows]

    def revoke(self, owner: str, token_id: str) -> bool:
        if names_no_uuid_row(self.engine, token_id):
            return False
        with store_transaction(self.engine) as conn:
            result = conn.execute(update(mcp_tokens).where(mcp_tokens.c.id == token_id,
                mcp_tokens.c.owner_user_id == owner).values(revoked_at=datetime.now(UTC)))
        return bool(result.rowcount)


def _public(row: Any) -> dict[str, Any]:
    return {"id": str(row["id"]), "ownerUserId": str(row["owner_user_id"]), "name": row["name"],
            "computerId": row["computer_id"], "projectIds": row["project_ids"],
            "createdAt": format_db_time(row["created_at"]), "expiresAt": format_db_time(row["expires_at"]),
            "revokedAt": format_db_time(row["revoked_at"]) if row["revoked_at"] else None}
