"""Stable UUID identities for users and departments, including legacy handles."""

from __future__ import annotations

from uuid import UUID, uuid5

_RELAY_ENTITY_ID_NAMESPACE = UUID("c8fa2fd5-5eca-4cc6-b763-a5ae1a57ff63")


def normalize_database_id(value: str | None) -> str | None:
    """Return a canonical UUID or None for legacy human-readable identifiers."""
    if not value or not value.strip():
        return None
    try:
        return str(UUID(value.strip()))
    except ValueError:
        return None


# Handles hash under the "employee" kind: the name predates "user", and
# changing it would give every handle-derived id a different UUID.
USER_ENTITY_KIND = "employee"


def database_id_for_reference(value: str, entity_kind: str) -> str:
    """Map a UUID or legacy human handle to one stable UUID-backed identity."""
    normalized = normalize_database_id(value)
    if normalized:
        return normalized
    return str(uuid5(_RELAY_ENTITY_ID_NAMESPACE, f"{entity_kind}:{value.strip()}"))
