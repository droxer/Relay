"""Trust boundary between a CDN edge (Cloudflare) and the backend.

The edge adds ``X-Relay-Edge: <secret>`` to every request it proxies. A request
carrying a configured secret came through the edge, so its client-IP header is
the real client; one without it either bypassed the edge or was forged, and the
guard turns it away before any route runs.
"""

from __future__ import annotations

import hmac
from ipaddress import ip_address

from starlette.datastructures import Headers
from starlette.requests import Request
from starlette.responses import JSONResponse
from starlette.types import ASGIApp, Receive, Scope, Send

from ..core import deploy_config

EDGE_SECRET_HEADER = "x-relay-edge"

# Platform health checks reach the container directly, never through the edge.
_UNGUARDED_PATHS = frozenset({"/healthz"})


def edge_request_verified(headers: Headers) -> bool:
    presented = headers.get(EDGE_SECRET_HEADER, "").encode("utf-8")
    if not presented:
        return False
    # Check every secret so the comparison time does not reveal which one matched.
    matches = [hmac.compare_digest(presented, secret.encode("utf-8")) for secret in deploy_config.edge_secrets()]
    return any(matches)


def client_ip(request: Request) -> str:
    """The caller's address for rate limiting: the edge's word, else the socket peer."""
    peer = request.client.host if request.client else "unknown"
    header = deploy_config.client_ip_header()
    if not header or not edge_request_verified(request.headers):
        return peer
    try:
        return str(ip_address(request.headers.get(header, "").strip()))
    except ValueError:
        return peer


class EdgeOriginGuardMiddleware:
    """Reject requests that reach the origin without passing through the edge."""

    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] not in ("http", "websocket") or scope.get("path") in _UNGUARDED_PATHS:
            await self.app(scope, receive, send)
            return
        if edge_request_verified(Headers(scope=scope)):
            await self.app(scope, receive, send)
            return
        if scope["type"] == "websocket":
            await send({"type": "websocket.close", "code": 1008})
            return
        response = JSONResponse({"detail": "Requests must arrive through the edge."}, status_code=403)
        await response(scope, receive, send)
