"""Answer an unchanged poll with 304 instead of the whole list.

The web UI polls a handful of list endpoints every few seconds; most answers
are byte-identical to the previous one. These responses carry a weak ETag and
``private, no-cache``, so the browser keeps its copy and revalidates it, and an
unchanged list costs a 304 instead of the full JSON. The body is still built
per request: this saves the transfer and the client's work, not the query.

Only lists free of secrets are allowlisted, because ``no-cache`` lets the
browser store them (``/sandboxes`` can carry a sandbox token, so it stays
``no-store``). The ETag is weak because Cloudflare drops strong ETags from the
responses it compresses.
"""

from __future__ import annotations

import hashlib

from starlette.types import ASGIApp, Message, Receive, Scope, Send

from .contract import API_PREFIX

POLLED_LISTS = frozenset(
    f"{API_PREFIX}{path}"
    for path in ("/threads", "/tasks", "/projects", "/daemon-nodes", "/agents", "/teams")
)
CACHE_CONTROL = b"private, no-cache"


def weak_etag(body: bytes) -> bytes:
    return b'W/"' + hashlib.sha256(body).hexdigest()[:32].encode() + b'"'


def etag_matches(header: bytes, etag: bytes) -> bool:
    """RFC 9110 weak comparison against an If-None-Match list."""
    candidates = {part.strip() for part in header.split(b",")}
    return b"*" in candidates or etag in candidates or etag[2:] in candidates


class ConditionalGetMiddleware:
    def __init__(self, app: ASGIApp, paths: frozenset[str] = POLLED_LISTS) -> None:
        self.app = app
        self.paths = paths

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http" or scope["method"] != "GET" or scope["path"] not in self.paths:
            await self.app(scope, receive, send)
            return
        if_none_match = dict(scope.get("headers", [])).get(b"if-none-match")
        start: Message | None = None
        chunks: list[bytes] = []

        async def buffered(message: Message) -> None:
            nonlocal start
            if message["type"] == "http.response.start":
                start = message
                return
            if message["type"] != "http.response.body" or start is None:
                await send(message)
                return
            chunks.append(message.get("body", b""))
            if message.get("more_body", False):
                return
            await _finish(start, b"".join(chunks), if_none_match, send)

        await self.app(scope, receive, buffered)


async def _finish(start: Message, body: bytes, if_none_match: bytes | None, send: Send) -> None:
    headers = list(start.get("headers", []))
    content_type = next((value for key, value in headers if key.lower() == b"content-type"), b"")
    if start["status"] != 200 or not content_type.startswith(b"application/json"):
        await send(start)
        await send({"type": "http.response.body", "body": body})
        return
    etag = weak_etag(body)
    replaced = (b"cache-control", b"etag", b"content-length")
    kept = [(key, value) for key, value in headers if key.lower() not in replaced]
    kept += [(b"etag", etag), (b"cache-control", CACHE_CONTROL)]
    if if_none_match is not None and etag_matches(if_none_match, etag):
        await send({**start, "status": 304, "headers": kept})
        await send({"type": "http.response.body", "body": b""})
        return
    await send({**start, "headers": [*kept, (b"content-length", str(len(body)).encode())]})
    await send({"type": "http.response.body", "body": body})
