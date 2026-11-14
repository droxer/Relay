"""Client release identity survives storage and tracks each registration."""
from __future__ import annotations

import pytest
from fastapi.testclient import TestClient
from relay.app import create_app
from relay.core.daemon_capabilities import DAEMON_NODE_CAPABILITIES, client_outdated, missing_capabilities
from relay.core.models import DaemonNodeRegistration
from relay.notifications.watcher import ComputerNotificationWatcher
from user_ids import user_id


def register(app, **extra):
    return app.state.registry.register({
        "sandboxId": "versioned_node", "userId": user_id("alice"),
        "token": "node_token", "workspacePath": "/workspace/alice",
        "protocolVersion": 1, "supportedAgents": ["codex"], **extra,
    })


def test_client_version_survives_database_roundtrip(tmp_path):
    app = create_app(str(tmp_path))
    register(app, clientVersion="1.2.3-rc.1+build.42")
    assert app.state.registry.get("versioned_node")["clientVersion"] == "1.2.3-rc.1+build.42"
    register(app, clientVersion="1.3.0")
    assert app.state.registry.get("versioned_node")["clientVersion"] == "1.3.0"


def test_legacy_registration_clears_previously_reported_version(tmp_path):
    app = create_app(str(tmp_path))
    register(app, clientVersion="1.2.3")
    assert app.state.registry.get("versioned_node").get("clientVersion") == "1.2.3"
    register(app)
    assert "clientVersion" not in app.state.registry.get("versioned_node")


@pytest.mark.parametrize("version", ["", "1.2", "v1.2.3", "01.2.3", "1.2.3-01", "a" * 129, 123])
def test_registration_schema_rejects_invalid_versions(version):
    with pytest.raises(ValueError):
        DaemonNodeRegistration.model_validate({
            "sandboxId": "node", "token": "token", "protocolVersion": 1,
            "clientVersion": version,
        })


def test_registration_wire_returns_release_and_rejects_invalid_input(tmp_path):
    app = create_app(str(tmp_path))
    register(app)
    client = TestClient(app)
    payload = {
        "sandboxId": "versioned_node", "token": "node_token",
        "protocolVersion": 2, "supportedAgents": ["codex"],
        "clientVersion": "2.3.4",
    }
    response = client.post("/api/v1/daemon-node-registrations", json=payload)
    assert response.status_code == 200, response.text
    assert response.json()["clientVersion"] == "2.3.4"
    assert app.state.registry.monitor_nodes()[0]["clientVersion"] == "2.3.4"
    response = client.post("/api/v1/daemon-node-registrations", json={
        **payload, "clientVersion": "not-a-version",
    })
    assert response.status_code == 400
    assert app.state.registry.get("versioned_node")["clientVersion"] == "2.3.4"


def test_pre_output_ack_registration_is_outdated_until_upgraded(tmp_path):
    app = create_app(str(tmp_path))
    context = app.state.context
    client = TestClient(app)
    register(app)
    payload = {
        "sandboxId": "versioned_node", "token": "node_token", "protocolVersion": 2,
        "supportedAgents": ["codex"],
        "capabilities": sorted(DAEMON_NODE_CAPABILITIES - {"durable-output-ack"}),
    }
    response = client.post("/api/v1/daemon-node-registrations", json=payload)
    assert response.status_code == 200, response.text
    node = context.daemon_store.get_node("versioned_node")
    assert node["capabilities"] == payload["capabilities"]
    assert missing_capabilities(node) == ["durable-output-ack"]
    assert client_outdated(node)
    assert context.registry.monitor_nodes()[0]["clientOutdated"] is True

    watcher = ComputerNotificationWatcher(context.registry, context.auth_store, context.notification_store)
    watcher.tick()
    watcher.tick()
    notices = context.notification_store.list_for_user(user_id("alice"))["notifications"]
    outdated = [notice for notice in notices if notice["kind"] == "client_outdated"]
    assert len(outdated) == 1
    assert outdated[0]["data"]["nodeId"] == "versioned_node"
    assert outdated[0]["data"]["missingCapabilities"] == ["durable-output-ack"]

    response = client.post("/api/v1/daemon-node-registrations", json={
        **payload, "capabilities": sorted(DAEMON_NODE_CAPABILITIES),
    })
    assert response.status_code == 200, response.text
    node = context.daemon_store.get_node("versioned_node")
    assert "durable-output-ack" in node["capabilities"]
    assert missing_capabilities(node) == []
    assert not client_outdated(node)
    assert context.registry.monitor_nodes()[0]["clientOutdated"] is False
    watcher.tick()
    assert context.notification_store.watch_states("client-outdated:") == {
        "client-outdated:versioned_node": "current",
    }
