"""The HTTP edge: security and timing middleware, CORS, and the JSON 500 handler.
"""

from __future__ import annotations

import re
import time
from typing import ClassVar
from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from loguru import logger
from starlette.middleware.gzip import GZipMiddleware
from starlette.responses import JSONResponse
from starlette.types import ASGIApp, Message, Receive, Scope, Send
from ..core import deploy_config
from ..security.request_auth import USER_COOKIE_NAME


CORS_PREFLIGHT_MAX_AGE_SECONDS = 7200
# Bodies under this stay uncompressed: the gzip header costs more than it
# saves, and most JSON answers to a poll are a few hundred bytes.
GZIP_MINIMUM_SIZE_BYTES = 1024


def compressed(app: ASGIApp) -> ASGIApp:
    """Gzip a response the client accepts compressed and that is worth it.

    Starlette's middleware already leaves a ``text/event-stream`` response
    alone (``DEFAULT_EXCLUDED_CONTENT_TYPES``), so the SSE thread stream is
    never buffered inside a gzip member; ``test_sse_responses_are_never_gzipped``
    pins that. A response that already carries ``Content-Encoding`` is passed
    through as well.
    """
    return GZipMiddleware(app, minimum_size=GZIP_MINIMUM_SIZE_BYTES)


class ServerTimingMiddleware:
    """Expose backend time-to-response-headers without buffering response bodies."""

    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        started_at = time.perf_counter()

        async def send_with_timing(message: Message) -> None:
            if message["type"] == "http.response.start":
                duration_ms = (time.perf_counter() - started_at) * 1000
                headers = list(message.get("headers", []))
                headers.append(
                    (b"server-timing", f"app;dur={duration_ms:.2f}".encode("ascii"))
                )
                message = {**message, "headers": headers}
            await send(message)

        await self.app(scope, receive, send_with_timing)


class CookieRequestGuardMiddleware:
    """Reject cross-site mutations that carry a browser session cookie."""

    _unsafe_methods: ClassVar[set[str]] = {"POST", "PUT", "PATCH", "DELETE"}

    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http" or scope.get("method") not in self._unsafe_methods:
            await self.app(scope, receive, send)
            return
        headers = {
            key.decode("latin-1").lower(): value.decode("latin-1")
            for key, value in scope.get("headers", [])
        }
        cookie = headers.get("cookie", "")
        if f"{USER_COOKIE_NAME}=" not in cookie:
            await self.app(scope, receive, send)
            return
        origin = headers.get("origin", "").rstrip("/")
        fetch_site = headers.get("sec-fetch-site", "").lower()
        origin_allowed = origin and _request_origin_allowed(scope, headers, origin)
        # A same-origin browser request can reach Relay through the Next.js
        # rewrite proxy with the public Origin preserved but the upstream Host
        # substituted. Sec-Fetch-Site is browser-controlled, so it identifies
        # that safe proxy case without trusting spoofable X-Forwarded-* values.
        if (origin and not origin_allowed and fetch_site != "same-origin") or (
            not origin and fetch_site == "cross-site"
        ):
            response = JSONResponse(
                {"detail": "Cross-site request rejected."}, status_code=403
            )
            await response(scope, receive, send)
            return
        await self.app(scope, receive, send)


def _request_origin_allowed(scope: Scope, headers: dict[str, str], origin: str) -> bool:
    host = headers.get("host", "")
    if host and origin == f"{scope.get('scheme', 'http')}://{host}":
        return True
    if origin in deploy_config.cors_allow_origins():
        return True
    pattern = deploy_config.cors_allow_origin_regex()
    return bool(pattern and re.fullmatch(pattern, origin))


class SecurityHeadersMiddleware:
    """Apply one browser hardening policy to API and backend-served UI.

    Compression sits directly inside this layer (``compressed``): the security
    headers are added to the compressed response, and the Server-Timing and
    conditional-GET layers below it see the uncompressed body, so an ETag is
    computed over the bytes the route produced.
    """

    def __init__(self, app: ASGIApp) -> None:
        self.app = compressed(app)

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        async def send_with_security_headers(message: Message) -> None:
            if message["type"] == "http.response.start":
                headers = list(message.get("headers", []))
                existing = {key.lower() for key, _value in headers}

                def add(key: bytes, value: bytes) -> None:
                    if key.lower() not in existing:
                        headers.append((key, value))

                add(b"x-content-type-options", b"nosniff")
                add(b"x-frame-options", b"DENY")
                add(b"referrer-policy", b"strict-origin-when-cross-origin")
                add(
                    b"content-security-policy",
                    b"base-uri 'self'; object-src 'none'; frame-ancestors 'none'",
                )
                add(
                    b"permissions-policy",
                    b"camera=(), microphone=(), geolocation=()",
                )
                if str(scope.get("path", "")).startswith("/api"):
                    add(b"cache-control", b"no-store")
                if scope.get("scheme") == "https":
                    add(
                        b"strict-transport-security",
                        b"max-age=31536000; includeSubDomains",
                    )
                message = {**message, "headers": headers}
            await send(message)

        await self.app(scope, receive, send_with_security_headers)


async def unhandled_error(request: Request, error: Exception) -> JSONResponse:
    """Answer an unexpected fault with the API's JSON error shape.

    Starlette re-raises after this responds, so the server still logs the
    traceback; this line ties it to the request and never echoes the error
    text, which can carry internal ids or SQL.
    """
    logger.error(
        "Unhandled request error",
        method=request.method,
        path=request.url.path,
        error_type=type(error).__name__,
    )
    return JSONResponse({"detail": "Internal server error."}, status_code=500)


def configure_cors(app: FastAPI) -> None:
    """Allow a separately hosted web UI to call the API with session cookies.

    A no-op unless origins are configured, which keeps the single-origin
    deployment free of CORS headers it does not need. ``allow_credentials`` is
    required because Relay authenticates with a cookie, and it is what forces
    the exact-origin rule enforced in ``deploy_config.cors_allow_origins``.
    """
    if not deploy_config.cors_enabled():
        return
    origins = deploy_config.cors_allow_origins()
    origin_regex = deploy_config.cors_allow_origin_regex()
    app.add_middleware(
        CORSMiddleware,
        allow_origins=origins,
        allow_origin_regex=origin_regex,
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
        # The web client reads Last-Event-ID off SSE frames, not headers, but
        # Server-Timing is read by the browser devtools panel on every request.
        expose_headers=["Server-Timing"],
        # Credentialed JSON calls each need a preflight; cache it for Chrome's
        # two-hour ceiling (Starlette's default is ten minutes) so the browser
        # skips that extra round trip to the origin.
        max_age=CORS_PREFLIGHT_MAX_AGE_SECONDS,
    )
    logger.info(
        "CORS enabled for cross-origin web UI",
        origins=origins,
        origin_regex=origin_regex,
    )
