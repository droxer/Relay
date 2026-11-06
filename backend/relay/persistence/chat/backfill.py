"""One-time conversion of local SQLite chat documents after table creation.

Production PostgreSQL conversion belongs to Alembic revision 0116. SQLite
installations create their schema from metadata and convert the two old record
arrays here in one transaction. Invalid data leaves both source documents intact.
"""

from typing import Any

from sqlalchemy import delete, insert, select

from ..resource_lock import resource_transaction
from ..tables.chat import audit_events, conversations, documents


def _records(key: str, value: Any) -> list[dict[str, Any]]:
    if not isinstance(value, list) or any(not isinstance(item, dict) for item in value):
        raise ValueError(f"Legacy chat {key} must be an array of records.")
    if key == "audit":
        if any(item.get("integrationId") is not None and not isinstance(item["integrationId"], str) for item in value):
            raise ValueError("Legacy chat audit integrationId must be a string or null.")
    else:
        seen = set()
        for item in value:
            if any(not isinstance(item.get(field), str) or not item[field] for field in ("key", "sessionId")):
                raise ValueError("Legacy chat conversations need nonempty key and sessionId strings.")
            if item["key"] in seen:
                raise ValueError("Legacy chat conversations contain duplicate keys.")
            seen.add(item["key"])
    return value


def convert_sqlite_records(engine: Any) -> None:
    with resource_transaction(engine, "chat-legacy-records") as conn:
        rows = conn.execute(select(documents.c.document_key, documents.c.payload).where(
            documents.c.document_key.in_(("audit", "conversations")),
        )).all()
        source = {key: _records(key, value) for key, value in rows}
        for key, records in source.items():
            target = audit_events if key == "audit" else conversations
            for offset in range(0, len(records), 500):
                batch = [
                    {"sequence": offset + index + 1, "payload": item, **(
                        {"integration_id": item.get("integrationId")} if key == "audit"
                        else {"conversation_key": item["key"], "session_id": item["sessionId"]}
                    )}
                    for index, item in enumerate(records[offset:offset + 500])
                ]
                conn.execute(insert(target), batch)
        if source:
            conn.execute(delete(documents).where(documents.c.document_key.in_(source)))
