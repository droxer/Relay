"""Stable mailbox identity from a verified provider ID token."""

import re
import secrets
from collections.abc import Callable
from typing import Any

import jwt

from ..core.connections import ConnectionConfig, ConnectionError

GOOGLE_KEYS = "https://www.googleapis.com/oauth2/v3/certs"
MICROSOFT = "https://login.microsoftonline.com"
PERSONAL_MICROSOFT_TENANT = "9188040d-6c67-4c5b-b112-36a304b66dad"
GMAIL = "https://gmail.googleapis.com/gmail/v1/users/me"
GRAPH_INBOX = "https://graph.microsoft.com/v1.0/me/mailFolders/inbox"
GUID = re.compile(r"[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}")


def verify_identity(request: Callable[..., Any], config: ConnectionConfig, tokens: dict[str, Any],
                    nonce: str) -> dict[str, str]:
    id_token = tokens.get("id_token")
    if not isinstance(id_token, str) or not id_token or len(id_token) > 16_384:
        raise ConnectionError("connection_identity_invalid", 422)

    tenant = "google.com"
    issuers: tuple[str, ...] = ("https://accounts.google.com", "accounts.google.com")
    key_url = GOOGLE_KEYS
    try:
        header = jwt.get_unverified_header(id_token)
        if header.get("alg") != "RS256" or not isinstance(header.get("kid"), str):
            raise ValueError
        if config.provider == "outlook":
            unsigned = jwt.decode(id_token, options={"verify_signature": False})
            tenant = unsigned.get("tid", "")
            if not isinstance(tenant, str) or not GUID.fullmatch(tenant):
                raise ValueError
            # The issuer and the signing key must both permit the token's tenant.
            issuers = (f"{MICROSOFT}/{tenant}/v2.0",)
            key_url = f"{MICROSOFT}/common/discovery/v2.0/keys"
        key_set = request("GET", key_url, mail=True)
        keys = key_set.get("keys", []) if isinstance(key_set, dict) else []
        matching = [
            key for key in keys if isinstance(key, dict) and key.get("kid") == header["kid"]
            and key.get("kty") == "RSA" and key.get("use", "sig") == "sig"
            and key.get("alg", "RS256") == "RS256" and _key_issuer_matches(key, issuers, tenant)
        ]
        if len(matching) != 1:
            raise ValueError
        claims = jwt.decode(id_token, jwt.PyJWK.from_dict(matching[0], algorithm="RS256"),
            algorithms=["RS256"], audience=config.client_id, issuer=issuers,
            options={"require": ["iss", "aud", "exp", "iat", "sub", "nonce"], "strict_aud": True})
        if not isinstance(claims["nonce"], str) or not secrets.compare_digest(claims["nonce"].encode(), nonce.encode()):
            raise ValueError
        subject = claims["sub"] if config.provider == "gmail" else claims.get("oid", "")
        if not subject or not isinstance(subject, str) or (config.provider == "outlook" and not GUID.fullmatch(subject)):
            raise ValueError
    except ConnectionError:
        raise
    except (jwt.PyJWTError, ValueError, TypeError, KeyError) as error:
        raise ConnectionError("connection_identity_invalid", 422) from error

    if config.provider == "gmail":
        profile = request("GET", f"{GMAIL}/profile", token=tokens["access_token"], mail=True,
            missing="connection_mailbox_unavailable")
        address = _string(profile, "emailAddress")
        if not address:
            raise ConnectionError("connection_mailbox_unavailable", 422)
        return {"subject": subject, "identity": address, "tenant": tenant}

    inbox = request("GET", GRAPH_INBOX, token=tokens["access_token"], mail=True,
        params={"$select": "id"}, missing="connection_mailbox_unavailable")
    if not _string(inbox, "id"):
        raise ConnectionError("connection_mailbox_unavailable", 422)
    address = _string(claims, "preferred_username") or _string(claims, "name")
    if not address:
        raise ConnectionError("connection_identity_invalid", 422)
    identity = {"subject": subject, "identity": address, "tenant": tenant}
    if tenant != PERSONAL_MICROSOFT_TENANT:
        identity["tenantLabel"] = tenant
    return identity


def _key_issuer_matches(key: dict[str, Any], issuers: tuple[str, ...], tenant: str) -> bool:
    if tenant == "google.com":
        return True
    issuer = key.get("issuer")
    return isinstance(issuer, str) and issuer.replace("{tenantid}", tenant) in issuers


def _string(value: Any, key: str) -> str:
    field = value.get(key) if isinstance(value, dict) else None
    return field[:320] if isinstance(field, str) else ""
