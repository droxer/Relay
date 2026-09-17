"""Configuration seams for running the backend behind a managed platform.

Relay's default posture is single-origin: the backend serves both the JSON API
and the exported web UI, so browser sessions are same-origin and the session
cookie needs no special handling. A split deployment (web UI on Vercel, backend
on Railway) breaks that assumption in three places, and each one is read from
the environment here rather than scattered across route modules:

* the browser origin is no longer the backend origin, so cross-origin requests
  need CORS with credentials;
* a cross-site cookie needs ``SameSite=None; Secure``, while a sibling-subdomain
  cookie stays ``Lax`` and only needs a ``Domain``;
* TLS terminates at the platform edge, so the app sees ``http`` and must be told
  the public scheme is ``https`` before it marks cookies ``Secure``.

Every setting defaults to the single-origin behavior, so a self-hosted install
that sets none of these keeps working exactly as before.
"""

from __future__ import annotations

import os
import re
from ipaddress import ip_network
from urllib.parse import urlsplit

SameSite = str

_VALID_SAMESITE = ("lax", "strict", "none")


def _env(name: str) -> str:
    return os.environ.get(name, "").strip()


def public_backend_url() -> str | None:
    """Public API origin for daemon commands, independent of proxy routing.

    A configured origin is authoritative; never infer it from untrusted
    forwarded headers. Plain HTTP is allowed only for loopback development.
    """
    raw = os.environ.get("RELAY_PUBLIC_BACKEND_URL", "")
    value = raw.strip()
    if not value:
        return None
    message = (
        "RELAY_PUBLIC_BACKEND_URL must be an HTTPS origin without credentials, "
        "path, query, or fragment (HTTP is allowed for loopback development)."
    )
    try:
        parsed = urlsplit(value)
        valid_scheme = parsed.scheme == "https" or (
            parsed.scheme == "http"
            and parsed.hostname in ("localhost", "127.0.0.1", "::1")
        )
        if (
            not valid_scheme
            or not parsed.hostname
            or parsed.username is not None
            or parsed.password is not None
            or parsed.path not in ("", "/")
            or "?" in value
            or "#" in value
            or "\\" in value
            or any(character.isspace() for character in value)
            or any(ord(character) < 32 or ord(character) == 127 for character in raw)
            or parsed.port == 0
        ):
            raise ValueError("Invalid public origin")
    except ValueError:
        # Do not echo the value: a mistaken URL may contain credentials.
        raise RuntimeError(message) from None
    return value.rstrip("/")


def _flag(name: str, *, default: bool = False) -> bool:
    value = _env(name).lower()
    if not value:
        return default
    return value not in ("0", "false", "no", "off")


def cors_allow_origins() -> list[str]:
    """Exact browser origins allowed to call the API with credentials.

    Comma-separated. ``*`` is rejected: credentialed CORS forbids a wildcard
    origin, and silently dropping credentials would break login in a way that
    only shows up in the browser.
    """
    raw = _env("RELAY_CORS_ALLOW_ORIGINS")
    if not raw:
        return []
    origins = [origin.strip().rstrip("/") for origin in raw.split(",")]
    origins = [origin for origin in origins if origin]
    if "*" in origins:
        raise RuntimeError(
            "RELAY_CORS_ALLOW_ORIGINS cannot be '*': credentialed requests "
            "require exact origins. List each origin, or use "
            "RELAY_CORS_ALLOW_ORIGIN_REGEX for preview deployments."
        )
    return origins


def cors_allow_origin_regex() -> str | None:
    """Origin pattern for ephemeral preview deployments (Vercel preview URLs).

    Anchored on both ends so a pattern like ``https://relay-.*\\.vercel\\.app``
    cannot be satisfied by a suffix match from an attacker-controlled host.
    """
    pattern = _env("RELAY_CORS_ALLOW_ORIGIN_REGEX")
    if not pattern:
        return None
    try:
        re.compile(pattern)
    except re.error as error:
        raise RuntimeError(
            f"RELAY_CORS_ALLOW_ORIGIN_REGEX is not a valid regular expression: {error}"
        ) from error
    return f"^(?:{pattern})$"


def cors_enabled() -> bool:
    return bool(cors_allow_origins() or cors_allow_origin_regex())


def session_cookie_domain() -> str | None:
    """Cookie ``Domain``, e.g. ``.example.com`` to share across subdomains.

    Unset means a host-only cookie, which is what a single-origin install wants.
    """
    return _env("RELAY_SESSION_COOKIE_DOMAIN") or None


def session_cookie_samesite() -> SameSite:
    value = _env("RELAY_SESSION_COOKIE_SAMESITE").lower() or "lax"
    if value not in _VALID_SAMESITE:
        raise RuntimeError(
            "RELAY_SESSION_COOKIE_SAMESITE must be one of: lax, strict, none."
        )
    return value


def force_secure_cookies() -> bool:
    """Mark session cookies ``Secure`` regardless of the request scheme.

    Uvicorn's ``--proxy-headers`` already recovers ``https`` from
    ``X-Forwarded-Proto`` on platforms that send it. This is the explicit
    override for the rest, and it is implied by ``SameSite=None`` because
    browsers reject a cross-site cookie that is not ``Secure``.
    """
    return _flag("RELAY_FORCE_SECURE_COOKIES") or session_cookie_samesite() == "none"


def cookie_is_secure(request_scheme: str) -> bool:
    return force_secure_cookies() or request_scheme == "https"


def bind_host(default: str = "127.0.0.1") -> str:
    """Interface to listen on.

    Container platforms route to the container's published port, so the server
    must bind every interface there — ``HOST`` is the conventional name for
    that. The default stays loopback so a local ``make backend`` is not exposed
    to the network.
    """
    return _env("BACKEND_HOST") or _env("HOST") or default


def bind_port(default: int = 8790) -> int:
    """Port to listen on.

    ``PORT`` is injected by Railway (and most PaaS providers) and wins over the
    Relay-specific name only when the Relay-specific name is absent.
    """
    for name in ("BACKEND_PORT", "PORT"):
        value = _env(name)
        if value:
            try:
                return int(value)
            except ValueError as error:
                raise RuntimeError(
                    f"{name} must be an integer, got {value!r}."
                ) from error
    return default


def trust_proxy_headers() -> bool:
    """Honor ``X-Forwarded-Proto``/``X-Forwarded-For`` from the platform edge.

    Disabled by default because a directly reachable client can forge forwarded
    headers. Deployments behind a load balancer must enable this explicitly and
    configure ``RELAY_FORWARDED_ALLOW_IPS`` with the proxy addresses or CIDRs.
    """
    return _flag("RELAY_TRUST_PROXY_HEADERS")


def forwarded_allow_ips() -> str:
    """Comma-separated trusted proxy IP addresses/CIDRs for Uvicorn.

    A wildcard would make client identity and request scheme attacker-controlled,
    so it is never accepted even when proxy header support is explicitly enabled.
    """
    raw = _env("RELAY_FORWARDED_ALLOW_IPS")
    if not raw:
        raise RuntimeError(
            "RELAY_FORWARDED_ALLOW_IPS is required when "
            "RELAY_TRUST_PROXY_HEADERS is enabled."
        )
    proxies = [value.strip() for value in raw.split(",") if value.strip()]
    if "*" in proxies:
        raise RuntimeError("RELAY_FORWARDED_ALLOW_IPS cannot contain '*'.")
    for proxy in proxies:
        try:
            ip_network(proxy, strict=False)
        except ValueError as error:
            raise RuntimeError(
                "RELAY_FORWARDED_ALLOW_IPS entries must be IP addresses or CIDRs; "
                f"got {proxy!r}."
            ) from error
    return ",".join(proxies)
