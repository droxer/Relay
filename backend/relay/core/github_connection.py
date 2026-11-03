"""Deployment configuration for the read-only GitHub App connection."""

import os
import re
from dataclasses import dataclass, field
from urllib.parse import urlsplit

from cryptography.fernet import Fernet

from .settings import SettingsError


@dataclass(frozen=True)
class GitHubConfig:
    client_id: str
    client_secret: str = field(repr=False)
    app_slug: str
    callback_url: str
    encryption_key: str = field(repr=False)


def github_config_from_env() -> GitHubConfig | None:
    names = ("CLIENT_ID", "CLIENT_SECRET", "APP_SLUG", "CALLBACK_URL", "ENCRYPTION_KEY")
    values = {name: os.environ.get(f"RELAY_GITHUB_{name}", "").strip() for name in names}
    if not any(values.values()):
        return None
    problems = [f"RELAY_GITHUB_{name} is required when GitHub connection is enabled." for name in names if not values[name]]
    if not re.fullmatch(r"[a-z0-9]+(?:-[a-z0-9]+)*", values["APP_SLUG"]):
        problems.append("RELAY_GITHUB_APP_SLUG must be a GitHub App slug.")
    try:
        url = urlsplit(values["CALLBACK_URL"])
        if (not url.hostname or url.username or url.password or url.query or url.fragment
                or url.path != "/api/v1/account/github/callback"
                or (url.scheme != "https" and not (url.scheme == "http" and url.hostname in {"localhost", "127.0.0.1"}))):
            problems.append("RELAY_GITHUB_CALLBACK_URL must be the public HTTPS GitHub callback URL (HTTP only on localhost).")
    except ValueError:
        problems.append("RELAY_GITHUB_CALLBACK_URL is invalid.")
    try:
        Fernet(values["ENCRYPTION_KEY"].encode())
    except (ValueError, TypeError):
        problems.append("RELAY_GITHUB_ENCRYPTION_KEY must be a Fernet key.")
    if problems:
        raise SettingsError(problems)
    return GitHubConfig(values["CLIENT_ID"], values["CLIENT_SECRET"], values["APP_SLUG"], values["CALLBACK_URL"], values["ENCRYPTION_KEY"])
