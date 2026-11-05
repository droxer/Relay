"""Fixed-host provider adapters. No caller-controlled URLs or HTTP methods."""

import json
import re
from typing import Any
from urllib.parse import quote

import httpx

from ..core.connections import ConnectionConfig, ConnectionError, PROVIDERS

transport: httpx.BaseTransport | None = None
MAX_RESPONSE_BYTES = 1_048_576


def request(method: str, url: str, *, token: str | None = None, raw: bool = False, **kwargs: Any) -> Any:
    headers = {"Accept": "application/json", **({"Authorization": f"Bearer {token}"} if token else {})}
    try:
        with httpx.Client(timeout=15, follow_redirects=False, transport=transport) as client:
            with client.stream(method, url, headers=headers, **kwargs) as response:
                if response.status_code in (401, 403):
                    if response.headers.get("x-ratelimit-remaining") == "0":
                        raise ConnectionError("connection_rate_limited", 429)
                    raise ConnectionError("connection_reconnect_required", 409)
                if response.status_code == 429:
                    raise ConnectionError("connection_rate_limited", 429)
                if not 200 <= response.status_code < 300 and response.status_code != 400:
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
                    if code in {"invalid_auth", "token_revoked", "token_expired", "invalid_grant"}:
                        raise ConnectionError("connection_reconnect_required", 409)
                    raise ConnectionError("connection_provider_rejected", 422)
                if response.status_code == 400:
                    raise ConnectionError("connection_provider_rejected", 422)
                return result
    except (httpx.HTTPError, ValueError) as error:
        # ConnectionError is itself a ValueError; preserve its public code.
        if isinstance(error, ConnectionError):
            raise
        raise ConnectionError("connection_provider_unavailable", 502) from error


def exchange(config: ConnectionConfig, fields: dict[str, str]) -> dict[str, Any]:
    result = request("POST", PROVIDERS[config.provider].token_url,
        data={"client_id": config.client_id, "client_secret": config.client_secret, **fields})
    if not isinstance(result, dict) or not isinstance(result.get("access_token"), str) or not result["access_token"]:
        raise ConnectionError("connection_provider_rejected", 422)
    for name in ("expires_in", "refresh_token_expires_in"):
        if name in result and (type(result[name]) is not int or result[name] <= 0):
            raise ConnectionError("connection_provider_rejected", 422)
    return result


def identity(provider: str, token: str) -> dict[str, str]:
    if provider == "github":
        data = request("GET", "https://api.github.com/user", token=token)
        subject, label, tenant = data.get("id"), data.get("login"), "github.com"
    elif provider == "slack":
        data = request("POST", "https://slack.com/api/auth.test", token=token)
        subject, label, tenant = data.get("user_id"), data.get("user"), data.get("team_id")
        label = f"{label} · {data.get('team', tenant)}"
    else:
        data = request("GET", "https://openidconnect.googleapis.com/v1/userinfo", token=token)
        subject, label, tenant = data.get("sub"), data.get("email"), "google"
    if not subject or not label or not tenant:
        raise ConnectionError("connection_identity_invalid", 422)
    return {"subject": str(subject), "identity": str(label), "tenant": str(tenant)}


def resources(provider: str, token: str, cursor: str = "") -> dict[str, Any]:
    if len(cursor) > 1000 or any(ord(c) < 32 for c in cursor):
        raise ConnectionError("connection_cursor_invalid")
    if provider == "github":
        if cursor and (not cursor.isdigit() or not 1 <= int(cursor) <= 10000):
            raise ConnectionError("connection_cursor_invalid")
        page = int(cursor or "1")
        data = request("GET", "https://api.github.com/user/repos", token=token,
            params={"per_page": 50, "page": page, "sort": "full_name"})
        items = [{"id": r["full_name"], "name": r["full_name"]} for r in data]
        next_cursor = str(page + 1) if len(items) == 50 else None
    elif provider == "slack":
        data = request("GET", "https://slack.com/api/conversations.list", token=token,
            params={"types": "public_channel", "exclude_archived": "true", "limit": 50, "cursor": cursor})
        items = [{"id": r["id"], "name": f"#{r['name']}"} for r in data.get("channels", [])]
        next_cursor = (data.get("response_metadata") or {}).get("next_cursor") or None
    else:
        data = request("GET", "https://www.googleapis.com/drive/v3/files", token=token,
            params={"q": "trashed = false", "pageSize": 50, "pageToken": cursor,
                "fields": "nextPageToken,files(id,name,mimeType)", "orderBy": "name"})
        items = [{"id": r["id"], "name": r["name"]} for r in data.get("files", [])]
        next_cursor = data.get("nextPageToken")
    return {"resources": items, "nextCursor": next_cursor}


def valid_resource(provider: str, value: Any) -> bool:
    if not isinstance(value, str):
        return False
    pattern = r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+" if provider == "github" else r"[A-Za-z0-9_-]{1,200}"
    return bool(re.fullmatch(pattern, value)) and all(part not in {".", ".."} for part in value.split("/"))


def call(provider: str, token: str, action: str, resource: str, arguments: dict[str, Any]) -> Any:
    if not valid_resource(provider, resource) or action not in PROVIDERS[provider].actions:
        raise ConnectionError("connection_access_denied", 403)
    if provider == "github":
        if set(arguments) - {"state"} or arguments.get("state", "open") not in {"open", "closed", "all"}:
            raise ConnectionError("connection_arguments_invalid")
        return request("GET", f"https://api.github.com/repos/{resource}/issues", token=token,
            params={"state": arguments.get("state", "open"), "per_page": 50})
    if provider == "slack":
        if action == "slack.history":
            if arguments:
                raise ConnectionError("connection_arguments_invalid")
            return request("GET", "https://slack.com/api/conversations.history", token=token,
                params={"channel": resource, "limit": 50})
        text = arguments.get("text")
        if set(arguments) != {"text"} or not isinstance(text, str) or not 1 <= len(text) <= 4000:
            raise ConnectionError("connection_arguments_invalid")
        return request("POST", "https://slack.com/api/chat.postMessage", token=token,
            json={"channel": resource, "text": text, "unfurl_links": False, "unfurl_media": False})
    if arguments:
        raise ConnectionError("connection_arguments_invalid")
    base = f"https://www.googleapis.com/drive/v3/files/{quote(resource, safe='')}"
    metadata = request("GET", base, token=token, params={"fields": "id,name,mimeType"})
    if metadata.get("mimeType", "").startswith("application/vnd.google-apps."):
        content = request("GET", base + "/export", token=token, params={"mimeType": "text/plain"}, raw=True)
    else:
        content = request("GET", base, token=token, params={"alt": "media"}, raw=True)
    return {**metadata, "content": content}
