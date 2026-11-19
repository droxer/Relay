"""Fixed-host provider adapters. No caller-controlled URLs or HTTP methods."""

import json
import re
from typing import Any

import httpx

from ..core.connections import ConnectionConfig, ConnectionError, MAIL_PROVIDERS, PROVIDERS

transport: httpx.BaseTransport | None = None
MAX_RESPONSE_BYTES = 1_048_576


def request(method: str, url: str, *, token: str | None = None, raw: bool = False,
            headers: dict[str, str] | None = None, mail: bool = False, missing: str | None = None,
            **kwargs: Any) -> Any:
    headers = {"Accept": "application/json", **(headers or {}), **({"Authorization": f"Bearer {token}"} if token else {})}
    try:
        with httpx.Client(timeout=15, follow_redirects=False, transport=transport) as client:
            with client.stream(method, url, headers=headers, **kwargs) as response:
                status = response.status_code
                if status == 404 and missing:
                    raise ConnectionError(missing, 404)
                if status == 401 or (status == 403 and not mail):
                    if response.headers.get("x-ratelimit-remaining") == "0":
                        raise ConnectionError("connection_rate_limited", 429)
                    raise ConnectionError("connection_reconnect_required", 409)
                if status == 429:
                    raise ConnectionError("connection_rate_limited", 429)
                if not 200 <= status < 300 and status not in ({400, 403} if mail else {400}):
                    raise ConnectionError("connection_provider_unavailable", 502)
                content = bytearray()
                for chunk in response.iter_bytes():
                    content.extend(chunk)
                    if len(content) > MAX_RESPONSE_BYTES:
                        raise ConnectionError("connection_response_too_large", 502)
                if raw:
                    return bytes(content).decode("utf-8", errors="replace")
                result = json.loads(content)
                if isinstance(result, dict) and (result.get("error") or result.get("ok") is False):
                    code = result.get("error")
                    if isinstance(code, str) and code in {"invalid_auth", "token_revoked", "token_expired", "invalid_grant"}:
                        raise ConnectionError("connection_reconnect_required", 409)
                    if mail:
                        _mail_error(result, status, missing)
                    raise ConnectionError("connection_provider_rejected", 422)
                if status in (400, 403):
                    raise ConnectionError("connection_provider_rejected", 422)
                return result
    except (httpx.HTTPError, ValueError) as error:
        # ConnectionError is itself a ValueError; preserve its public code.
        if isinstance(error, ConnectionError):
            raise
        raise ConnectionError("connection_provider_unavailable", 502) from error


def _mail_error(result: dict[str, Any], status: int, missing: str | None) -> None:
    error = result.get("error")
    codes = {error} if isinstance(error, str) else set()
    if isinstance(error, dict):
        code = error.get("code")
        if isinstance(code, str):
            codes.add(code)
        for key in ("errors", "details"):
            details = error.get(key)
            if isinstance(details, list):
                codes.update(item["reason"] for item in details
                    if isinstance(item, dict) and isinstance(item.get("reason"), str))
    if codes & {"rateLimitExceeded", "userRateLimitExceeded", "ErrorThrottled"}:
        raise ConnectionError("connection_rate_limited", 429)
    if codes & {"admin_policy_enforced", "organizationPolicy", "domainPolicy", "insufficient_claims"}:
        raise ConnectionError("connection_organization_policy", 403)
    if codes & {"insufficientPermissions", "ACCESS_TOKEN_SCOPE_INSUFFICIENT"}:
        raise ConnectionError("connection_reconnect_required", 409)
    if missing and codes & {"failedPrecondition", "MailboxNotEnabledForRESTAPI", "ErrorMailboxNotEnabledForRESTAPI",
                            "ErrorInvalidUser", "ErrorItemNotFound"}:
        raise ConnectionError(missing, 404)
    if status == 403:
        raise ConnectionError("connection_provider_access_denied", 403)


def exchange(config: ConnectionConfig, fields: dict[str, str]) -> dict[str, Any]:
    _require_provider(config.provider)
    result = request("POST", PROVIDERS[config.provider].token_url, mail=config.provider in MAIL_PROVIDERS,
        data={"client_id": config.client_id, "client_secret": config.client_secret, **fields})
    if not isinstance(result, dict) or not isinstance(result.get("access_token"), str) or not result["access_token"]:
        raise ConnectionError("connection_provider_rejected", 422)
    for name in ("expires_in", "refresh_token_expires_in"):
        if name in result and (type(result[name]) is not int or result[name] <= 0):
            raise ConnectionError("connection_provider_rejected", 422)
    if config.provider in MAIL_PROVIDERS and ("expires_in" not in result
            or ("refresh_token" in result and not isinstance(result["refresh_token"], str))):
        raise ConnectionError("connection_provider_rejected", 422)
    return result


def identity(provider: str, token: str) -> dict[str, str]:
    if provider != "github":
        raise ConnectionError("connection_access_denied", 403)
    data = request("GET", "https://api.github.com/user", token=token)
    subject, label, tenant = data.get("id"), data.get("login"), "github.com"
    if not subject or not label or not tenant:
        raise ConnectionError("connection_identity_invalid", 422)
    return {"subject": str(subject), "identity": str(label), "tenant": str(tenant)}


def resources(provider: str, token: str, cursor: str = "") -> dict[str, Any]:
    _require_provider(provider)
    if provider in MAIL_PROVIDERS:
        if cursor:
            raise ConnectionError("connection_cursor_invalid")
        return {"resources": [{"id": "inbox", "name": "Inbox"}], "nextCursor": None}
    if len(cursor) > 1000 or (cursor and (not cursor.isdigit() or not 1 <= int(cursor) <= 10000)):
        raise ConnectionError("connection_cursor_invalid")
    page = int(cursor or "1")
    data = request("GET", "https://api.github.com/user/repos", token=token,
        params={"per_page": 50, "page": page, "sort": "full_name"})
    items = [{"id": r["full_name"], "name": r["full_name"]} for r in data]
    next_cursor = str(page + 1) if len(items) == 50 else None
    return {"resources": items, "nextCursor": next_cursor}


def valid_resource(provider: str, value: Any) -> bool:
    if provider not in PROVIDERS or not isinstance(value, str):
        return False
    if provider in MAIL_PROVIDERS:
        return value == "inbox"
    pattern = r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+"
    return bool(re.fullmatch(pattern, value)) and all(part not in {".", ".."} for part in value.split("/"))


def call(provider: str, token: str, action: str, resource: str, arguments: dict[str, Any]) -> Any:
    if provider != "github" or not valid_resource(provider, resource) or action not in PROVIDERS[provider].actions:
        raise ConnectionError("connection_access_denied", 403)
    if set(arguments) - {"state"} or arguments.get("state", "open") not in ("open", "closed", "all"):
        raise ConnectionError("connection_arguments_invalid")
    return request("GET", f"https://api.github.com/repos/{resource}/issues", token=token,
        params={"state": arguments.get("state", "open"), "per_page": 50})


def _require_provider(provider: str) -> None:
    if provider not in PROVIDERS:
        raise ConnectionError("connection_access_denied", 403)
