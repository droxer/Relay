"""Unexpected faults answer in the API's JSON shape without leaking their text."""

from __future__ import annotations

from pathlib import Path

from fastapi.routing import APIRoute
from fastapi.testclient import TestClient
from relay.api.contract import API_PREFIX
from relay.app import create_app


def _client(monkeypatch, tmp_path: Path) -> TestClient:
    monkeypatch.setenv("RELAY_TASK_SCHEDULER_ENABLED", "0")
    return TestClient(create_app(tmp_path / "state"), raise_server_exceptions=False)


def test_an_unhandled_error_is_a_json_500_without_the_error_text(monkeypatch, tmp_path: Path) -> None:
    client = _client(monkeypatch, tmp_path)

    def explode() -> None:
        raise RuntimeError("SELECT secret FROM accounts")

    # Ahead of the web UI catch-all, which would otherwise answer the path.
    client.app.router.routes.insert(0, APIRoute("/__probe/explode", explode))

    response = client.get("/__probe/explode")

    assert response.status_code == 500
    assert response.json() == {"detail": "Internal server error."}
    assert "secret" not in response.text


def test_a_registration_fault_is_a_retryable_500_not_a_client_error(monkeypatch, tmp_path: Path) -> None:
    client = _client(monkeypatch, tmp_path)

    def broken_register(*_args, **_kwargs):
        raise RuntimeError("database connection reset")

    registry = client.app.state.registry
    monkeypatch.setattr(registry, "get", lambda sandbox_id: {"id": sandbox_id, "userId": "alice"})
    monkeypatch.setattr(registry, "register", broken_register)

    response = client.post(
        f"{API_PREFIX}/daemon-node-registrations",
        json={"sandboxId": "sbx_1", "token": "node_token", "protocolVersion": 2},
    )

    # The daemon retries 5xx with backoff; a 400 would tell it the request
    # itself was wrong.
    assert response.status_code == 500
    assert "connection reset" not in response.text
