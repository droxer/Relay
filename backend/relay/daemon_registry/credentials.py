from __future__ import annotations

import hashlib
import hmac
import secrets
from base64 import urlsafe_b64encode
from typing import Any


def hash_daemon_node_token(token: str | None) -> str | None:
    if not token:
        return None
    return "sha256:" + hashlib.sha256(token.encode("utf-8")).hexdigest()


def new_daemon_node_token() -> str:
    return "tok_" + secrets.token_urlsafe(24).rstrip("=")


def managed_daemon_node_token(
    enrollment_credential: str, sandbox_id: str
) -> str:
    """Derive a replayable runtime token without persisting its plaintext."""
    digest = hmac.new(
        enrollment_credential.encode("utf-8"),
        f"relay-managed-runtime:{sandbox_id}".encode(),
        hashlib.sha256,
    ).digest()
    return "tok_" + urlsafe_b64encode(digest).decode("ascii").rstrip("=")


def _hash_matches(expected: str | None, token: str | None) -> bool:
    provided = hash_daemon_node_token(token)
    return bool(
        expected
        and provided
        and len(expected) == len(provided)
        and hmac.compare_digest(expected, provided)
    )


def _credential_hash(sandbox: dict[str, Any], field: str) -> str | None:
    """Read a split credential hash.

    Migration 0049 backfilled the pre-split `tokenHash` into whichever of
    `uiTokenHash`/`nodeTokenHash` was empty, so there is no legacy field left to
    fall back to.
    """
    explicit = sandbox.get(field)
    if isinstance(explicit, str) and explicit:
        return explicit
    return hash_daemon_node_token(sandbox.get("token"))


def sandbox_ui_token_matches(sandbox: dict[str, Any], token: str | None) -> bool:
    return _hash_matches(_credential_hash(sandbox, "uiTokenHash"), token)


def daemon_node_token_matches(sandbox: dict[str, Any], token: str | None) -> bool:
    return _hash_matches(_credential_hash(sandbox, "nodeTokenHash"), token)


def sandbox_ui_auth_error(sandbox: dict[str, Any], token: str | None) -> str | None:
    if not sandbox.get("uiTokenHash") and not sandbox.get("token"):
        return "Sandbox token is required." if sandbox.get("nodeTokenHash") else None
    if not token:
        return "Sandbox token is required."
    if not sandbox_ui_token_matches(sandbox, token):
        return "Invalid sandbox token."
    return None


def sandbox_node_auth_error(sandbox: dict[str, Any], token: str | None) -> str | None:
    if not sandbox.get("nodeTokenHash") and not sandbox.get("token"):
        return None
    if not token:
        return "Daemon node token is required."
    if not daemon_node_token_matches(sandbox, token):
        return "Invalid daemon node token."
    return None
