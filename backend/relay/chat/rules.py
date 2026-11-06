"""Pure provider configuration and conversation rules shared with persistence."""

from typing import Any, Literal
from urllib.parse import urlparse, urlunsplit

ChatProvider = Literal["discord", "telegram", "lark"]
ChatIntegrationStatus = Literal["draft", "active", "degraded", "disabled"]

CHAT_PROVIDERS = {"discord", "telegram", "lark"}
CHAT_STATUSES = {"draft", "active", "degraded", "disabled"}

SECRET_FIELDS = {
    "botToken",
    "clientSecret",
    "signingSecret",
    "webhookSecret",
    "appSecret",
    "verificationToken",
    "encryptKey",
}


def _provider(value: Any) -> ChatProvider:
    if value not in CHAT_PROVIDERS:
        raise ValueError("provider must be discord, telegram, or lark.")
    return value


def _status(value: Any) -> ChatIntegrationStatus:
    if value not in CHAT_STATUSES:
        raise ValueError("status must be draft, active, degraded, or disabled.")
    return value


def _string(value: Any) -> str | None:
    if value is None:
        return None
    text = str(value).strip()
    return text or None


def _required_string(value: Any, field: str) -> str:
    text = _string(value)
    if not text:
        raise ValueError(f"{field} is required.")
    return text


def list_field(record: dict[str, Any], key: str) -> list[Any]:
    """``record[key]`` when it is a list, else an empty list."""
    value = record.get(key)
    return value if isinstance(value, list) else []


def dict_field(record: dict[str, Any], key: str) -> dict[str, Any]:
    """``record[key]`` when it is a dict, else an empty dict."""
    value = record.get(key)
    return value if isinstance(value, dict) else {}


def _public_config(value: Any) -> dict[str, Any]:
    if not isinstance(value, dict):
        return {}
    return {
        str(key): item
        for key, item in value.items()
        if key not in SECRET_FIELDS and item is not None and not isinstance(item, (dict, list))
    }


def public_callback_base_url(integration: dict[str, Any]) -> str:
    config = dict_field(integration, "config")
    value = _string(config.get("publicBaseUrl"))
    parsed = urlparse(value or "")
    if (
        not value
        or any(character.isspace() for character in value)
        or "\\" in value
        or parsed.scheme != "https"
        or not parsed.hostname
        or parsed.username is not None
        or parsed.password is not None
        or parsed.path not in {"", "/"}
        or bool(parsed.query)
        or bool(parsed.fragment)
    ):
        raise ValueError("A valid HTTPS public callback URL must be configured from the Channels setup page.")
    return urlunsplit((parsed.scheme, parsed.netloc, parsed.path.rstrip("/"), "", ""))


def _conversation_key(payload: dict[str, Any]) -> str:
    provider = _provider(payload.get("provider"))
    tenant_id = _string(payload.get("tenantId")) or ""
    conversation_id = _required_string(payload.get("conversationId"), "conversationId")
    thread_id = _string(payload.get("threadId")) or ""
    return "::".join([provider, tenant_id, conversation_id, thread_id])


def _conversation_allowed(integration: dict[str, Any], conversation_id: str, thread_id: str | None) -> bool:
    allowed = list_field(integration, "allowedConversations")
    for record in allowed:
        if record.get("conversationId") != conversation_id:
            continue
        required_thread = record.get("threadId")
        if required_thread and required_thread != thread_id:
            continue
        return True
    return False


def _identity_link(integration: dict[str, Any], external_user_id: str) -> dict[str, Any] | None:
    links = list_field(integration, "identityLinks")
    return next((link for link in links if link.get("externalUserId") == external_user_id), None)
