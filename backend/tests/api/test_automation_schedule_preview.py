from __future__ import annotations

from tempfile import TemporaryDirectory

from fastapi.testclient import TestClient

from test_automation_triggers_api import _client

PREVIEW = "/api/v1/automations/schedule-preview"


def test_schedule_preview_returns_three_fires(monkeypatch) -> None:
    with TemporaryDirectory() as root:
        client, _ = _client(monkeypatch, root)
        response = client.post(PREVIEW, json={"schedule": {"timezone": "UTC", "repeat": {"every": "hour", "minute": 0}}})
        assert response.status_code == 200, response.text
        body = response.json()
        assert body["summary"] == "Hourly at :00 (UTC)" and len(body["next"]) == 3
        assert body["next"] == sorted(body["next"])


def test_schedule_preview_400_names_the_field(monkeypatch) -> None:
    with TemporaryDirectory() as root:
        client, _ = _client(monkeypatch, root)
        response = client.post(PREVIEW, json={"schedule": {"timezone": None, "repeat": {"cron": "* * * * *"}}})
        assert response.status_code == 400 and "15 minutes" in response.json()["detail"]


def test_schedule_preview_requires_auth(monkeypatch) -> None:
    with TemporaryDirectory() as root:
        client, _ = _client(monkeypatch, root)
        anonymous = TestClient(client.app)
        assert anonymous.post(PREVIEW, json={"schedule": {}}).status_code == 401
