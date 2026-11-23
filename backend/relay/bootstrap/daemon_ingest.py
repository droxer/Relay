"""Bound daemon report requests before they use a worker thread or read a body."""

import re

from starlette.responses import JSONResponse
from starlette.types import ASGIApp, Receive, Scope, Send

from ..api.contract import API_PREFIX

_REPORT_PATH = re.compile(rf"{API_PREFIX}/daemon-nodes/([^/]+)/(?:events|reports)")


class DaemonIngestMiddleware:
    def __init__(self, app: ASGIApp, *, concurrency: int) -> None:
        self.app = app
        self.concurrency = concurrency
        self.active_nodes: set[str] = set()

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        match = (_REPORT_PATH.fullmatch(scope["path"])
                 if scope["type"] == "http" and scope["method"] == "POST" else None)
        if match is None:
            await self.app(scope, receive, send)
            return

        node_id = match[1]
        # Same-Computer ingest serializes on the registry's node lock anyway.
        # Admission and cleanup run on the request event loop.
        if node_id in self.active_nodes or len(self.active_nodes) >= self.concurrency:
            response = JSONResponse(
                {"detail": "Daemon report processing is busy. Retry shortly."},
                status_code=503,
                headers={"Retry-After": "1", "Cache-Control": "no-store"},
            )
            await response(scope, receive, send)
            return

        self.active_nodes.add(node_id)
        try:
            await self.app(scope, receive, send)
        finally:
            self.active_nodes.remove(node_id)
