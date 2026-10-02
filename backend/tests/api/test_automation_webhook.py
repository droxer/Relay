from __future__ import annotations

from tempfile import TemporaryDirectory
from datetime import datetime, timezone

from test_automation_triggers_api import _client, _routine

HEADER = "X-Relay-Automation-Token"


def _webhook_automation(client, agent) -> tuple[dict, str]:
    routine = _routine(client, agent, routineTrigger={"kind": "webhook"})
    response = client.post(f"/api/v1/tasks/{routine['id']}/automation/webhook-secret")
    assert response.status_code == 201, response.text
    body = response.json()
    assert body["path"] == f"/api/v1/automations/{routine['id']}/webhook"
    return routine, body["secret"]


def test_webhook_accepts_json_with_the_secret(monkeypatch) -> None:
    with TemporaryDirectory() as root:
        client, agent = _client(monkeypatch, root)
        routine, secret = _webhook_automation(client, agent)
        response = client.post(f"/api/v1/automations/{routine['id']}/webhook",
                               json={"ref": "main"}, headers={HEADER: secret})
        assert response.status_code == 202
        assert response.json() == {"accepted": True}
        [row] = client.app.state.automation_store.claim_outbox(10, datetime.now(timezone.utc))
        assert row["payload"] == {"body": {"ref": "main"}}


def test_webhook_refuses_bad_tokens_and_unknown_routines_alike(monkeypatch) -> None:
    with TemporaryDirectory() as root:
        client, agent = _client(monkeypatch, root)
        routine, _ = _webhook_automation(client, agent)
        assert client.post(f"/api/v1/automations/{routine['id']}/webhook", json={}).status_code == 401
        assert client.post(f"/api/v1/automations/{routine['id']}/webhook", json={},
                           headers={HEADER: "wrong"}).status_code == 401
        assert client.post("/api/v1/automations/nope/webhook", json={},
                           headers={HEADER: "wrong"}).status_code == 401


def test_webhook_rejects_oversize_and_non_json(monkeypatch) -> None:
    with TemporaryDirectory() as root:
        client, agent = _client(monkeypatch, root)
        routine, secret = _webhook_automation(client, agent)
        url = f"/api/v1/automations/{routine['id']}/webhook"
        assert client.post(url, content=b"x", headers={HEADER: secret, "content-type": "text/plain"}).status_code == 415
        big = b'{"blob":"' + b"x" * (64 * 1024) + b'"}'
        assert client.post(url, content=big, headers={HEADER: secret, "content-type": "application/json"}).status_code == 413
        assert client.post(url, content=b"{nope", headers={HEADER: secret, "content-type": "application/json"}).status_code == 400


def test_webhook_to_paused_automation_is_refused(monkeypatch) -> None:
    with TemporaryDirectory() as root:
        client, agent = _client(monkeypatch, root)
        routine, secret = _webhook_automation(client, agent)
        client.patch(f"/api/v1/tasks/{routine['id']}", json={"routineEnabled": False})
        url = f"/api/v1/automations/{routine['id']}/webhook"
        assert client.post(url, json={}, headers={HEADER: secret}).status_code == 409
        client.patch(f"/api/v1/tasks/{routine['id']}", json={"routineEnabled": True})
        assert client.app.state.automation_store.claim_outbox(10, datetime.now(timezone.utc)) == []


def test_rotating_invalidates_the_old_secret_and_status_reports_it(monkeypatch) -> None:
    with TemporaryDirectory() as root:
        client, agent = _client(monkeypatch, root)
        routine, first = _webhook_automation(client, agent)
        second = client.post(f"/api/v1/tasks/{routine['id']}/automation/webhook-secret").json()["secret"]
        url = f"/api/v1/automations/{routine['id']}/webhook"
        assert client.post(url, json={}, headers={HEADER: first}).status_code == 401
        assert client.post(url, json={}, headers={HEADER: second}).status_code == 202
        status = client.get(f"/api/v1/tasks/{routine['id']}/automation/webhook-secret").json()
        assert status["configured"] is True
        assert "secret" not in status


def test_leaving_webhook_deletes_the_secret(monkeypatch) -> None:
    with TemporaryDirectory() as root:
        client, agent = _client(monkeypatch, root)
        routine, secret = _webhook_automation(client, agent)
        client.patch(f"/api/v1/tasks/{routine['id']}", json={"routineTrigger": {"kind": "manual"}})
        assert client.app.state.automation_store.has_webhook_secret(routine["id"]) is False


def test_secret_requires_a_webhook_automation(monkeypatch) -> None:
    with TemporaryDirectory() as root:
        client, agent = _client(monkeypatch, root)
        routine = _routine(client, agent)
        assert client.post(f"/api/v1/tasks/{routine['id']}/automation/webhook-secret").status_code == 409
