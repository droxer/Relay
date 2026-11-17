"""Slow-write diagnostics measure response delivery without reading bodies."""
import asyncio
from unittest.mock import Mock

import pytest

from relay.bootstrap import http


@pytest.mark.parametrize("fails", [False, True])
def test_slow_write_logs_response_outcome_and_route(monkeypatch, fails):
    clock = iter([0.0, 0.1, 6.0])
    monkeypatch.setattr(http.time, "perf_counter", lambda: next(clock))
    log = Mock()
    monkeypatch.setattr(http, "logger", log)

    async def endpoint(scope, receive, send):
        await send({"type": "http.response.start", "status": 202, "headers": []})
        if fails:
            raise RuntimeError("delivery interrupted")
        await send({"type": "http.response.body", "body": b"{}"})

    async def send(message):
        pass

    scope = {"type": "http", "method": "POST", "path": "/api/v1/threads/private/cancellations"}
    call = http.ServerTimingMiddleware(endpoint)(scope, None, send)
    if fails:
        with pytest.raises(RuntimeError):
            asyncio.run(call)
    else:
        asyncio.run(call)
    log.warning.assert_called_once()
    fields = log.warning.call_args.kwargs
    assert fields["duration_ms"] == 6000
    assert fields["method"] == "POST"
    assert fields["status"] == 202
    assert fields["response_complete"] is (not fails)
    assert fields["path"] == scope["path"]


def test_completion_request_is_logged_even_when_fast(monkeypatch):
    clock = iter([0.0, 0.1, 0.2])
    monkeypatch.setattr(http.time, "perf_counter", lambda: next(clock))
    log = Mock()
    monkeypatch.setattr(http, "logger", log)

    async def endpoint(scope, receive, send):
        scope["state"] = {"run_completed_count": 1, "artifact_count": 150, "run_id": "run"}
        await send({"type": "http.response.start", "status": 200, "headers": []})
        await send({"type": "http.response.body", "body": b"{}"})

    async def send(message):
        pass

    asyncio.run(http.ServerTimingMiddleware(endpoint)({"type": "http", "method": "POST", "path": "/reports"}, None, send))
    assert log.info.call_args.kwargs["artifact_count"] == 150
    assert log.info.call_args.kwargs["duration_ms"] == 200
    assert log.info.call_args.kwargs["response_complete"] is True
    log.warning.assert_not_called()
