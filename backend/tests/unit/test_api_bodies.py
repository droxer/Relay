from __future__ import annotations

import asyncio
from types import SimpleNamespace

import pytest
from fastapi import HTTPException
from relay.api import bodies
from relay.api.bodies import assignment_list, json_body
from starlette.requests import Request


def _app(max_json_body_bytes: int = 4 * 1024 * 1024) -> SimpleNamespace:
    # Routes read settings off the AppContext (``app.state.context``).
    settings = SimpleNamespace(max_json_body_bytes=max_json_body_bytes)
    return SimpleNamespace(state=SimpleNamespace(context=SimpleNamespace(settings=settings)))


def test_json_body_translates_client_disconnect_to_http_error() -> None:
    async def receive() -> dict[str, str]:
        return {"type": "http.disconnect"}

    request = Request(
        {
            "type": "http",
            "method": "POST",
            "path": "/api/v1/daemon-node-registrations",
            "headers": [],
            "app": _app(),
        },
        receive,
    )

    with pytest.raises(HTTPException) as raised:
        asyncio.run(json_body(request))

    assert raised.value.status_code == 400
    assert raised.value.detail == "Client disconnected while reading request body."


def test_json_body_rejects_payloads_over_the_configured_limit(monkeypatch) -> None:
    messages = iter(
        [
            {"type": "http.request", "body": b'{"value"', "more_body": True},
            {"type": "http.request", "body": b": 12345}", "more_body": False},
        ]
    )

    async def receive() -> dict[str, object]:
        return next(messages)

    request = Request(
        {
            "type": "http",
            "method": "POST",
            "path": "/api/v1/tasks",
            "headers": [(b"content-type", b"application/json")],
            "app": _app(max_json_body_bytes=8),
        },
        receive,
    )

    with pytest.raises(HTTPException) as raised:
        asyncio.run(json_body(request))

    assert raised.value.status_code == 413
    assert raised.value.detail == "JSON request body exceeds the 8 byte limit."


def test_json_body_rejects_an_oversized_chunk_before_copying_it() -> None:
    append_chunk = bodies.append_json_body_chunk
    body = bytearray(b"ok")

    with pytest.raises(HTTPException) as raised:
        append_chunk(body, b"oversized", 4)

    assert raised.value.status_code == 413
    assert body == b"ok"


def test_assignment_list_preserves_and_bounds_per_assignment_briefs() -> None:
    [assignment] = assignment_list(
        [
            {
                "agent": "codex",
                "brief": f"  {'x' * 4100}  ",
            }
        ]
    )

    assert assignment["brief"] == "x" * 4000
