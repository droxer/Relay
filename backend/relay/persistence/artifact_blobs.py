"""Where a workspace-artifact snapshot lives when a blob store holds it.

The artifact row keeps ``blobKey`` and ``sha256`` in its metadata instead of
the bytes. Keys group by thread so deleting a thread removes its snapshots
with one prefix delete.
"""

from __future__ import annotations

import hashlib
import hmac
from typing import Any
from urllib.parse import quote

from loguru import logger

from .blob_store import BlobStore

_PREFIX = "session-artifacts"


def session_blob_prefix(session_id: str) -> str:
    return f"{_PREFIX}/{quote(session_id, safe='')}/"


def artifact_blob_key(session_id: str, artifact_id: str) -> str:
    return session_blob_prefix(session_id) + quote(artifact_id, safe="")


def blob_metadata(key: str, content: bytes) -> dict[str, str]:
    return {"blobKey": key, "sha256": hashlib.sha256(content).hexdigest()}


def read_blob_snapshot(blob_store: BlobStore | None, metadata: dict[str, Any]) -> bytes | None:
    """The snapshot bytes, or None when they cannot be served faithfully.

    None sends the download route to the live workspace read, the same path an
    artifact without any snapshot takes.
    """
    key = metadata["blobKey"]
    if blob_store is None:
        logger.warning("Artifact snapshot is in a blob store that is not configured", blob_key=key)
        return None
    content = blob_store.get(key)
    if content is None:
        logger.warning("Artifact snapshot blob is missing", blob_key=key)
        return None
    expected = str(metadata.get("sha256") or "")
    if not hmac.compare_digest(hashlib.sha256(content).hexdigest(), expected):
        logger.error("Artifact snapshot blob does not match its recorded hash", blob_key=key)
        return None
    return content


def delete_session_blobs(blob_store: BlobStore | None, session_id: str) -> None:
    """Best effort after the thread's rows are gone; a leftover is only bytes."""
    if blob_store is None:
        return
    try:
        blob_store.delete_prefix(session_blob_prefix(session_id))
    except Exception as error:  # noqa: BLE001 - the deletion already committed
        logger.warning("Could not delete a deleted thread's snapshot blobs", session_id=session_id, error=str(error))
