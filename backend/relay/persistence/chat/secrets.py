"""Per-integration Fernet envelopes and atomic conversion of the old map."""

import json
from typing import Any

from cryptography.fernet import Fernet, InvalidToken
from sqlalchemy import delete, insert, select, update

from ..engine import store_transaction
from ..resource_lock import resource_transaction
from ..tables.chat import documents, integration_secrets, integrations


def decrypt_secret(cipher: Fernet | None, ciphertext: str | None) -> dict[str, Any]:
    if ciphertext is None:
        return {}
    if cipher is None:
        raise ValueError("RELAY_CHAT_SECRET_KEY is required to read database chat secrets.")
    try:
        value = json.loads(cipher.decrypt(ciphertext.encode()))
    except InvalidToken as error:
        raise ValueError("RELAY_CHAT_SECRET_KEY cannot decrypt database chat secrets.") from error
    if not isinstance(value, dict):
        raise ValueError("Database chat secrets have an invalid encrypted format.")
    return value


def read_secret(engine: Any, cipher: Fernet | None, integration_id: str) -> dict[str, Any]:
    with store_transaction(engine) as conn:
        ciphertext = conn.scalar(
            select(integration_secrets.c.ciphertext).where(
                integration_secrets.c.integration_id == integration_id,
            )
        )
    return decrypt_secret(cipher, ciphertext)


def secret_keys(engine: Any, integration_id: str) -> list[str]:
    with store_transaction(engine) as conn:
        return (
            conn.scalar(
                select(integration_secrets.c.secret_keys).where(
                    integration_secrets.c.integration_id == integration_id,
                )
            )
            or []
        )


def write_secret(engine: Any, cipher: Fernet | None, integration_id: str, values: dict[str, Any]) -> None:
    if cipher is None:
        raise ValueError("RELAY_CHAT_SECRET_KEY is required to store database chat secrets.")
    ciphertext = cipher.encrypt(json.dumps(values, separators=(",", ":")).encode()).decode()
    with store_transaction(engine) as conn:
        result = conn.execute(
            update(integration_secrets)
            .where(
                integration_secrets.c.integration_id == integration_id,
            )
            .values(ciphertext=ciphertext, secret_keys=sorted(values))
        )
        if not result.rowcount:
            conn.execute(
                insert(integration_secrets).values(
                    integration_id=integration_id,
                    ciphertext=ciphertext,
                    secret_keys=sorted(values),
                )
            )


def ensure_legacy_secrets_converted(
    engine: Any, cipher: Fernet | None, *, integration_id: str | None = None,
    active_only: bool = False, force: bool = False,
) -> None:
    # Steady-state calls perform a small indexed existence read, with no global
    # lock or credential payload. Only the one-time conversion takes that lock.
    statement = select(documents.c.id).where(documents.c.document_key == "secrets")
    if not force:
        needed = select(integrations.c.integration_id)
        if integration_id is not None:
            needed = needed.where(integrations.c.integration_id == integration_id)
        if active_only:
            needed = needed.where(integrations.c.status == "active")
        statement = statement.where(needed.exists())
    with store_transaction(engine) as conn:
        legacy = conn.scalar(statement)
    if legacy is None:
        return
    with resource_transaction(engine, "chat-legacy-secrets") as conn:
        row = conn.execute(
            select(documents.c.payload)
            .where(
                documents.c.document_key == "secrets",
            )
            .with_for_update()
        ).first()
        if row is None:
            return
        if conn.scalar(select(integration_secrets.c.integration_id).limit(1)) is not None:
            raise ValueError("Legacy and normalized chat secrets coexist; reconcile them before conversion.")
        value = row[0]
        if not isinstance(value, dict):
            raise ValueError("Legacy chat secrets must be an encrypted envelope or map.")
        if isinstance(value.get("ciphertext"), str):
            values = decrypt_secret(cipher, value["ciphertext"])
        else:
            values = value
        if any(not key or not isinstance(item, dict) for key, item in values.items()):
            raise ValueError("Legacy chat secrets must map integration IDs to objects.")
        if values and cipher is None:
            raise ValueError("RELAY_CHAT_SECRET_KEY is required to convert database chat secrets.")
        for key, item in values.items():
            write_secret(engine, cipher, key, item)
        conn.execute(delete(documents).where(documents.c.document_key == "secrets"))
