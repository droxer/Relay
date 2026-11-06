"""Queries and writes for individual integration configuration records."""

from typing import Any
from sqlalchemy import insert, or_, select, update

from ..engine import store_transaction
from ..tables.chat import integrations, integration_secrets


def integration_values(payload: dict[str, Any]) -> dict[str, Any]:
    return {
        "integration_id": payload["id"],
        "payload": payload,
        **{
            column: payload.get(key) if isinstance(payload.get(key), str) else None
            for column, key in (("provider", "provider"), ("status", "status"), ("tenant_id", "tenantId"))
        },
    }


def read_integration(engine: Any, integration_id: str) -> dict[str, Any]:
    with store_transaction(engine) as conn:
        payload = conn.scalar(select(integrations.c.payload).where(integrations.c.integration_id == integration_id))
    if payload is None:
        raise KeyError(integration_id)
    return payload


def write_integration(engine: Any, payload: dict[str, Any], *, create: bool = False) -> None:
    with store_transaction(engine) as conn:
        values = integration_values(payload)
        if create:
            conn.execute(insert(integrations).values(**values))
        else:
            conn.execute(update(integrations).where(integrations.c.integration_id == payload["id"]).values(**values))


def public_records(engine: Any, integration_id: str | None = None) -> list[tuple[dict[str, Any], list[str]]]:
    statement = (
        select(integrations.c.payload, integration_secrets.c.secret_keys)
        .select_from(
            integrations.outerjoin(
                integration_secrets, integrations.c.integration_id == integration_secrets.c.integration_id
            )
        )
        .order_by(integrations.c.sequence)
    )
    if integration_id is not None:
        statement = statement.where(integrations.c.integration_id == integration_id)
    with store_transaction(engine) as conn:
        return [(payload, keys or []) for payload, keys in conn.execute(statement)]


def runtime_records(engine: Any) -> list[tuple[dict[str, Any], str | None]]:
    statement = (
        select(integrations.c.payload, integration_secrets.c.ciphertext)
        .select_from(
            integrations.outerjoin(
                integration_secrets, integrations.c.integration_id == integration_secrets.c.integration_id
            )
        )
        .where(integrations.c.status == "active")
        .order_by(integrations.c.sequence)
    )
    with store_transaction(engine) as conn:
        return list(conn.execute(statement).tuples())


def identity_candidates(engine: Any, provider: str, tenant_id: str | None) -> list[dict[str, Any]]:
    statement = (
        select(integrations.c.payload)
        .where(
            integrations.c.provider == provider,
            integrations.c.status == "active",
            or_(
                integrations.c.tenant_id.is_(None),
                integrations.c.tenant_id == "",
                integrations.c.tenant_id == tenant_id,
            ),
        )
        .order_by(integrations.c.sequence)
    )
    with store_transaction(engine) as conn:
        return list(conn.scalars(statement))


def settings_record(engine: Any, integration_id: str) -> tuple[dict[str, Any], str | None]:
    statement = select(integrations.c.payload, integration_secrets.c.ciphertext).select_from(
        integrations.outerjoin(integration_secrets, integrations.c.integration_id == integration_secrets.c.integration_id)
    ).where(integrations.c.integration_id == integration_id)
    with store_transaction(engine) as conn:
        row = conn.execute(statement).first()
    if row is None:
        raise KeyError(integration_id)
    return row[0], row[1]
