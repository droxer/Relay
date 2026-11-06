"""Client release identity survives storage and tracks each registration."""
from __future__ import annotations

import pytest
from relay.app import create_app
from relay.core.models import DaemonNodeRegistration
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
