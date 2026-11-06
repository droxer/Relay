"""ASGI adapter: bearer authorization and origin policy precede SDK handling."""

from typing import Any
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from mcp.server.streamable_http_manager import StreamableHTTPSessionManager
from starlette.concurrency import run_in_threadpool
from starlette.datastructures import Headers
from starlette.responses import JSONResponse
from starlette.types import Message, Receive, Scope, Send
from ..security.request_origin import request_origin_allowed
from .access import authorize
from .errors import McpError
from .server import CURRENT_GRANT, create_server


class RelayMcpHttp:
    def __init__(self, ctx: Any):
        self.ctx = ctx
        self._sessions: StreamableHTTPSessionManager | None = None

    @asynccontextmanager
    async def run(self) -> AsyncIterator[None]:
        if self._sessions is not None:
            raise RuntimeError("Relay MCP is already running.")
        sessions = create_server(self.ctx)
        self._sessions = sessions
        try:
            async with sessions.run():
                yield
        finally:
            self._sessions = None

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        headers = Headers(scope=scope)
        scheme, _, token = headers.get("authorization", "").partition(" ")
        try:
            grant = await run_in_threadpool(authorize, self.ctx, token if scheme.lower() == "bearer" else None)
            origin = headers.get("origin")
            if origin and not request_origin_allowed(scope, dict(headers), origin):
                raise McpError(403, "Browser origin is not allowed.")
        except McpError as error:
            response = JSONResponse(
                {"detail": error.code},
                status_code=error.status,
                headers={
                    "Cache-Control": "no-store",
                    **({"WWW-Authenticate": "Bearer"} if error.status == 401 else {}),
                },
            )
            await response(scope, receive, send)
            return
        if scope["method"] != "POST":
            # Stateless JSON transport has no server-initiated event stream or
            # resumable session to delete. MCP permits 405 for these methods.
            await JSONResponse(
                {"detail": "Use POST for Relay MCP."},
                status_code=405,
                headers={"Allow": "POST", "Cache-Control": "no-store"},
            )(scope, receive, send)
            return

        async def send_private(message: Message) -> None:
            if message["type"] == "http.response.start":
                response_headers = [(k, v) for k, v in message.get("headers", []) if k.lower() != b"cache-control"]
                message = {**message, "headers": [*response_headers, (b"cache-control", b"no-store")]}
            await send(message)

        sessions = self._sessions
        if sessions is None:
            await JSONResponse(
                {"detail": "Relay MCP is not ready."}, status_code=503, headers={"Cache-Control": "no-store"}
            )(scope, receive, send)
            return
        context_token = CURRENT_GRANT.set(grant)
        try:
            await sessions.handle_request(scope, receive, send_private)
        finally:
            CURRENT_GRANT.reset(context_token)
