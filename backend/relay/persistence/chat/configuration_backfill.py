"""One-time SQLite configuration conversion; PostgreSQL uses Alembic 0117."""

from typing import Any
from sqlalchemy import delete, insert, select

from .integrations import integration_values
from ..resource_lock import resource_transaction
from ..tables.chat import documents, integrations


def convert_sqlite_configuration(engine: Any) -> None:
    with resource_transaction(engine, "chat-legacy-configuration") as conn:
        row = conn.execute(select(documents.c.payload).where(documents.c.document_key == "integrations")).first()
        if row is None:
            return
        values = row[0]
        if not isinstance(values, list) or any(
            not isinstance(item, dict) or not isinstance(item.get("id"), str) or not item["id"] for item in values
        ):
            raise ValueError("Legacy chat integrations must be objects with nonempty IDs.")
        if len({item["id"] for item in values}) != len(values):
            raise ValueError("Legacy chat integrations contain duplicate IDs.")
        for offset in range(0, len(values), 500):
            conn.execute(
                insert(integrations),
                [
                    {"sequence": offset + index + 1, **integration_values(item)}
                    for index, item in enumerate(values[offset : offset + 500])
                ],
            )
        conn.execute(delete(documents).where(documents.c.document_key == "integrations"))
