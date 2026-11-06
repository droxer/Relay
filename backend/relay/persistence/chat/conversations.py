"""Indexed conversation bindings; upserts serialize only the selected key."""

import hashlib
from typing import Any

from sqlalchemy import delete, insert, select, update

from ..engine import store_transaction
from ..resource_lock import resource_transaction
from ..tables.chat import conversations


def conversation_key_hash(key: str) -> str:
    # External identifiers have no wire length cap. Index fixed-size hashes
    # rather than raw keys, retaining and checking the full key on every read.
    return hashlib.sha256(key.encode()).hexdigest()


def get_conversation(engine: Any, key: str) -> dict[str, Any] | None:
    with store_transaction(engine) as conn:
        return conn.scalar(
            select(conversations.c.payload).where(
                conversations.c.key_hash == conversation_key_hash(key), conversations.c.conversation_key == key
            )
        )


def bind_conversation(engine: Any, record: dict[str, Any]) -> dict[str, Any]:
    key = record["key"]
    with resource_transaction(engine, f"chat-conversation:{key}") as conn:
        existing = conn.scalar(
            select(conversations.c.payload)
            .where(conversations.c.key_hash == conversation_key_hash(key), conversations.c.conversation_key == key)
            .with_for_update()
        )
        if existing is not None:
            # Retain creation time and legacy extension fields. A missing/blank
            # provider message id preserves the last one, as on the old wire.
            result = {
                **existing,
                "sessionId": record["sessionId"],
                "ownerUserId": record["ownerUserId"],
                "providerMessageId": record.get("providerMessageId") or existing.get("providerMessageId"),
                "updatedAt": record["updatedAt"],
            }
            conn.execute(
                update(conversations)
                .where(conversations.c.key_hash == conversation_key_hash(key), conversations.c.conversation_key == key)
                .values(
                    session_id=result["sessionId"],
                    payload=result,
                )
            )
        else:
            result = record
            conn.execute(
                insert(conversations).values(
                    key_hash=conversation_key_hash(key),
                    conversation_key=key,
                    session_id=record["sessionId"],
                    payload=record,
                )
            )
    return result


def clear_conversations(engine: Any, session_id: str) -> int:
    with store_transaction(engine) as conn:
        result = conn.execute(delete(conversations).where(conversations.c.session_id == session_id))
        return result.rowcount
