"""Images remain private and reach only their issuing Computer command."""

from __future__ import annotations

import base64
import pytest
from relay.persistence.events import relay_event

from test_thread_same_computer_targets import _world, _agent, _sync, _thread

PNG = base64.b64decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1cAAAAASUVORK5CYII=")


def test_upload_and_private_download(monkeypatch, database_io_off_event_loop):
    with _world(monkeypatch) as (_, client, _, _):
        response = client.post("/api/v1/thread-attachments", content=PNG, headers={"Content-Type": "image/png"})
        assert response.status_code == 201, response.text
        attachment = response.json()
        assert attachment["bytes"] == len(PNG)
        assert len(attachment["sha256"]) == 64
        assert client.get(f"/api/v1/thread-attachments/{attachment['id']}").content == PNG
        client.cookies.clear()
        assert client.get(f"/api/v1/thread-attachments/{attachment['id']}").status_code == 401


def test_rejects_fake_image(monkeypatch):
    with _world(monkeypatch) as (_, client, _, _):
        response = client.post(
            "/api/v1/thread-attachments", content=b"not an image", headers={"Content-Type": "image/png"}
        )
        assert response.status_code == 400


def test_message_carries_attachment_to_authorized_command(monkeypatch, database_io_off_event_loop):
    with _world(monkeypatch) as (app, client, here, there):
        agent = _agent(app, here, "Vision", "codex")
        app.state.registry.register(
            {
                **here,
                "sandboxId": "node_here",
                "protocolVersion": 1,
                "supportedAgents": ["codex", "claude"],
                "token": "token_node_here",
                "capabilities": [*here.get("capabilities", []), "image-attachments"],
            }
        )
        _sync(app, here, there)
        session = _thread(app, here, agent)
        attachment = client.post(
            "/api/v1/thread-attachments", content=PNG, headers={"Content-Type": "image/png"}
        ).json()
        response = client.post(
            f"/api/v1/threads/{session['id']}/messages",
            json={"text": "Describe this", "attachmentIds": [attachment["id"]]},
        )
        assert response.status_code == 202, response.text
        events = response.json()["events"]
        assert next(e for e in events if e["type"] == "user.message")["attachments"][0]["id"] == attachment["id"]
        [command] = app.state.registry.take_commands("node_here", "token_node_here")
        assert command["attachments"] == [attachment]
        path = f"/api/v1/daemon-nodes/node_here/attachments/{attachment['id']}?commandId={command['id']}"
        assert client.get(path, headers={"Authorization": "Bearer token_node_here"}).content == PNG
        assert client.get(path, headers={"Authorization": "Bearer wrong"}).status_code == 401
        assert (
            client.get(
                path.replace("node_here/attachments", "node_there/attachments"),
                headers={"Authorization": "Bearer token_node_there"},
            ).status_code
            == 404
        )
        assert (
            client.get(
                path.replace(command["id"], "unknown"), headers={"Authorization": "Bearer token_node_here"}
            ).status_code
            == 404
        )

        app.state.daemon_store.retire_command(command["id"], "test completed")
        assert client.get(path, headers={"Authorization": "Bearer token_node_here"}).status_code == 404


def test_upload_requires_auth_and_bounds_bytes(monkeypatch):
    with _world(monkeypatch) as (_, client, _, _):
        assert (
            client.post(
                "/api/v1/thread-attachments",
                content=b"x" * (10 * 1024 * 1024 + 1),
                headers={"Content-Type": "image/png"},
            ).status_code
            == 413
        )
        assert (
            client.post(
                "/api/v1/thread-attachments", content=b"<svg/>", headers={"Content-Type": "image/svg+xml"}
            ).status_code
            == 400
        )
        client.cookies.clear()
        assert (
            client.post("/api/v1/thread-attachments", content=PNG, headers={"Content-Type": "image/png"}).status_code
            == 401
        )


def test_staged_image_cannot_be_read_or_attached_by_another_user(monkeypatch):
    with _world(monkeypatch) as (app, client, here, there):
        attachment = client.post(
            "/api/v1/thread-attachments", content=PNG, headers={"Content-Type": "image/png"}
        ).json()
        app.state.auth_store.create_account("alice", "kestrel-vault-7720")
        client.cookies.clear()
        assert (
            client.post("/api/v1/auth/login", json={"username": "alice", "password": "kestrel-vault-7720"}).status_code
            == 200
        )
        assert client.get(f"/api/v1/thread-attachments/{attachment['id']}").status_code == 404
        with pytest.raises(ValueError, match="unavailable"):
            app.state.session_store.resolve_attachments(
                (attachment["id"],), app.state.auth_store.resolve_user_id("alice"), None
            )


def test_bad_attachment_ids_are_rejected(monkeypatch):
    with _world(monkeypatch) as (app, client, here, there):
        agent = _agent(app, here, "Vision", "codex")
        _sync(app, here, there)
        session = _thread(app, here, agent)
        for value in (["../../secret"], "image-id", [None], ["00000000-0000-0000-0000-000000000000"] * 5):
            response = client.post(
                f"/api/v1/threads/{session['id']}/messages", json={"text": "Describe", "attachmentIds": value}
            )
            assert response.status_code == 400, response.text


def _image_ready(app, here, there):
    agent = _agent(app, here, "Vision", "codex")
    app.state.registry.register(
        {
            **here,
            "sandboxId": "node_here",
            "protocolVersion": 1,
            "supportedAgents": ["codex", "claude"],
            "token": "token_node_here",
            "capabilities": [*here.get("capabilities", []), "image-attachments"],
        }
    )
    _sync(app, here, there)
    return agent


def test_opening_image_and_idempotent_new_thread(monkeypatch, database_io_off_event_loop):
    with _world(monkeypatch) as (app, client, here, there):
        agent = _image_ready(app, here, there)
        image = client.post("/api/v1/thread-attachments", content=PNG, headers={"Content-Type": "image/png"}).json()
        body = {
            "taskGoal": "Describe this",
            "assignments": [{"agentId": agent["id"]}],
            "attachmentIds": [image["id"]],
            "idempotencyKey": "opening-image",
        }
        first = client.post("/api/v1/agent-runs", json=body)
        assert first.status_code == 202, first.text
        session = first.json()
        assert next(event for event in session["events"] if event["type"] == "session.created")["attachments"] == [
            image
        ]
        assert not any(event["type"] == "user.message" for event in session["events"])
        again = client.post("/api/v1/agent-runs", json=body)
        assert again.status_code == 202, again.text
        assert again.json()["id"] == session["id"]
        [command] = app.state.registry.take_commands("node_here", "token_node_here")
        assert command["attachments"] == [image]
        changed = client.post("/api/v1/agent-runs", json={**body, "attachmentIds": []})
        assert changed.status_code == 409, changed.text


def test_followup_keeps_visual_context_without_reattaching_to_the_new_message(monkeypatch):
    with _world(monkeypatch) as (app, client, here, there):
        agent = _image_ready(app, here, there)
        session = _thread(app, here, agent)
        image = client.post("/api/v1/thread-attachments", content=PNG, headers={"Content-Type": "image/png"}).json()
        app.state.session_store.bind_attachments(
            [image["id"]], session["id"], app.state.auth_store.resolve_user_id("admin")
        )
        app.state.session_store.append_event(
            session["id"], relay_event("user.message", session["id"], {"text": "Describe", "attachments": [image]})
        )
        response = client.post(f"/api/v1/threads/{session['id']}/messages", json={"text": "Now compare the colors"})
        assert response.status_code == 202, response.text
        latest = [event for event in response.json()["events"] if event["type"] == "user.message"][-1]
        assert "attachments" not in latest
        [command] = app.state.registry.take_commands("node_here", "token_node_here")
        assert command["attachments"] == [image]


def test_old_computer_refuses_images_before_recording_message(monkeypatch):
    with _world(monkeypatch) as (app, client, here, there):
        agent = _agent(app, here, "Vision", "codex")
        _sync(app, here, there)
        session = _thread(app, here, agent)
        image = client.post("/api/v1/thread-attachments", content=PNG, headers={"Content-Type": "image/png"}).json()
        response = client.post(
            f"/api/v1/threads/{session['id']}/messages", json={"text": "Describe", "attachmentIds": [image["id"]]}
        )
        assert response.status_code == 409, response.text
        assert response.json()["detail"]["code"] == "image_client_update_required"
        assert not any(
            event["type"] == "user.message" for event in app.state.session_store.get_session(session["id"])["events"]
        )
