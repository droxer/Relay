"""Connection configuration and pure access vocabulary shared by execution."""

import os
from dataclasses import dataclass, field
from urllib.parse import urlsplit

from cryptography.fernet import Fernet

from .settings import SettingsError


class ConnectionError(ValueError):
    def __init__(self, code: str, status: int = 400):
        super().__init__(code)
        self.code, self.status = code, status


@dataclass(frozen=True)
class ConnectionConfig:
    provider: str
    client_id: str
    client_secret: str = field(repr=False)
    callback_url: str


@dataclass(frozen=True)
class Provider:
    name: str
    authorize_url: str
    token_url: str
    scopes: str
    actions: tuple[str, ...]
    required_scope: str
    pkce: bool = True


MAIL_PROVIDERS = frozenset({"gmail", "outlook"})
MAIL_AUTHORIZATION_VERSION = 1
GMAIL_READ_SCOPE = "https://www.googleapis.com/auth/gmail.readonly"
OUTLOOK_READ_SCOPE = "https://graph.microsoft.com/Mail.Read"

PROVIDERS = {
    "github": Provider("GitHub", "https://github.com/login/oauth/authorize",
        "https://github.com/login/oauth/access_token", "read:user repo offline_access", ("github.list_issues",), "repo"),
    "gmail": Provider("Gmail", "https://accounts.google.com/o/oauth2/v2/auth", "https://oauth2.googleapis.com/token",
        f"openid email {GMAIL_READ_SCOPE}", ("gmail.list_messages", "gmail.get_message"), GMAIL_READ_SCOPE),
    "outlook": Provider("Outlook", "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
        "https://login.microsoftonline.com/common/oauth2/v2.0/token", f"openid profile offline_access {OUTLOOK_READ_SCOPE}",
        ("outlook.list_messages", "outlook.get_message"), OUTLOOK_READ_SCOPE),
}


def connections_config_from_env() -> tuple[dict[str, ConnectionConfig], str | None]:
    configs = {}
    problems = []
    key = os.environ.get("RELAY_CONNECTIONS_ENCRYPTION_KEY", "").strip() or None
    for provider in PROVIDERS:
        prefix = f"RELAY_CONNECTIONS_{provider.upper().replace('-', '_')}_"
        values = [os.environ.get(prefix + name, "").strip() for name in ("CLIENT_ID", "CLIENT_SECRET", "CALLBACK_URL")]
        if not any(values):
            continue
        if not all(values):
            problems.append(f"{prefix}CLIENT_ID, CLIENT_SECRET and CALLBACK_URL must all be configured.")
            continue
        try:
            url = urlsplit(values[2])
            valid = (url.hostname and not url.username and not url.password and not url.query and not url.fragment
                and url.path == f"/api/v1/connections/callback/{provider}"
                and (url.scheme == "https" or (url.scheme == "http" and url.hostname in {"localhost", "127.0.0.1"})))
        except ValueError:
            valid = False
        if not valid:
            problems.append(f"{prefix}CALLBACK_URL must be the public HTTPS connection callback (HTTP only on localhost).")
        configs[provider] = ConnectionConfig(provider, *values)
    if key or configs:
        try:
            Fernet((key or "").encode())
        except (ValueError, TypeError):
            problems.append("RELAY_CONNECTIONS_ENCRYPTION_KEY must be a Fernet key when Connections are configured.")
    if problems:
        raise SettingsError(problems)
    return configs, key


def safe_return(value: str) -> str:
    if (not isinstance(value, str) or not value.startswith("/") or value.startswith("//")
            or "\\" in value or any(ord(c) < 32 for c in value) or len(value) > 1000):
        raise ConnectionError("connection_return_invalid")
    parts = urlsplit(value)
    if parts.scheme or parts.netloc or parts.fragment:
        raise ConnectionError("connection_return_invalid")
    return value
