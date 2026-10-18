"""Deterministic run-request ids derived from a caller's idempotency key.
"""

from __future__ import annotations

from uuid import UUID, uuid5


# Fixed namespace for deriving idempotent run-request ids. Changing it would
# make in-flight keys resolve to a different request and dispatch twice.
IDEMPOTENT_RUN_REQUEST_NAMESPACE = UUID("6f5c9d2e-1a47-4b8e-9c30-5d7ab1e84f62")


def idempotent_run_request_id(idempotency_key: str) -> str:
    """Derive the run request's primary key from a caller's idempotency key.

    ``daemon_run_requests.id`` is a native uuid column, so this must be a real
    uuid: a prefixed digest makes Postgres reject every lookup and insert with
    InvalidTextRepresentation, failing the dispatch outright. uuid5 keeps the
    property that matters — the same key always resolves to the same request.
    """
    return str(uuid5(IDEMPOTENT_RUN_REQUEST_NAMESPACE, idempotency_key))
