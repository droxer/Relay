"""Append-only chat audit records and bounded, ordered tails."""

from typing import Any

from sqlalchemy import insert, select

from ..engine import store_transaction
from ..tables.chat import audit_events


def append_audit_event(engine: Any, event: dict[str, Any]) -> None:
    # Enlist in the integration mutation's transaction, so audit and state
    # commit together. No historical payload is read or rewritten.
    with store_transaction(engine) as conn:
        conn.execute(insert(audit_events).values(integration_id=event.get("integrationId"), payload=event))


def read_audit_events(engine: Any, integration_id: str | None, limit: int) -> list[dict[str, Any]]:
    statement = select(audit_events.c.payload).order_by(audit_events.c.sequence.desc())
    if integration_id:
        statement = statement.where(audit_events.c.integration_id == integration_id)
    statement = statement.limit(max(1, min(limit, 200)))
    with store_transaction(engine) as conn:
        events = conn.scalars(statement).all()
    # The existing wire contract sends the selected tail oldest first.
    return list(reversed(events))
