from __future__ import annotations

from fastapi.testclient import TestClient
from relay.api.conditional_get import POLLED_LISTS, etag_matches, weak_etag
from relay.app import create_app


def _client(monkeypatch, tmp_path) -> TestClient:
    monkeypatch.setenv("RELAY_ADMIN_TOKEN", "admin_token")
    client = TestClient(create_app(str(tmp_path / "state")))
    assert client.post(
        "/api/v1/auth/bootstrap",
        json={"token": "admin_token", "username": "admin", "password": "kestrel-vault-7719"},
    ).status_code == 200
    return client


def test_an_unchanged_polled_list_answers_304(monkeypatch, tmp_path):
    client = _client(monkeypatch, tmp_path)
    for path in sorted(POLLED_LISTS):
        first = client.get(path)
        assert first.status_code == 200, path
        etag = first.headers["etag"]
        assert etag.startswith('W/"'), path
        # Stored by the browser and revalidated, never served stale.
        assert first.headers["cache-control"] == "private, no-cache", path
        again = client.get(path, headers={"If-None-Match": etag})
        assert again.status_code == 304, path
        assert again.content == b""
        assert again.headers["etag"] == etag


def test_a_changed_list_answers_200_with_a_new_etag(monkeypatch, tmp_path):
    client = _client(monkeypatch, tmp_path)
    before = client.get("/api/v1/tasks")
    assert client.post("/api/v1/tasks", json={"title": "Write the brief"}).status_code == 201
    after = client.get("/api/v1/tasks", headers={"If-None-Match": before.headers["etag"]})
    assert after.status_code == 200
    assert after.headers["etag"] != before.headers["etag"]
    assert [task["title"] for task in after.json()["tasks"]] == ["Write the brief"]


def test_unlisted_and_secret_bearing_routes_stay_no_store(monkeypatch, tmp_path):
    client = _client(monkeypatch, tmp_path)
    sandboxes = client.get("/api/v1/sandboxes")
    assert sandboxes.headers["cache-control"] == "no-store"
    assert "etag" not in sandboxes.headers
    # Errors are never cached either.
    client.post("/api/v1/auth/logout")
    rejected = client.get("/api/v1/tasks")
    assert rejected.status_code == 401
    assert "etag" not in rejected.headers
    assert rejected.headers["cache-control"] == "no-store"


def test_weak_comparison_accepts_either_form_and_lists():
    etag = weak_etag(b"{}")
    assert etag_matches(etag, etag)
    assert etag_matches(etag[2:], etag)
    assert etag_matches(b'W/"other", ' + etag, etag)
    assert etag_matches(b"*", etag)
    assert not etag_matches(b'W/"other"', etag)
