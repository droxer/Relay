from tempfile import TemporaryDirectory

import pytest
from fastapi.testclient import TestClient
from relay.app import create_app
from sqlalchemy import text


def test_local_credentials_are_hash_only(monkeypatch):
    monkeypatch.setenv('RELAY_ADMIN_TOKEN', 'admin_token')
    with TemporaryDirectory() as root:
        app = create_app(root)
        node, _, token = app.state.registry.provision_pending('alice', '/workspace', 'none')
        with app.state.daemon_store.engine.connect() as conn:
            secret = conn.execute(text('SELECT node_token_secret FROM daemon_nodes')).scalar()
        assert secret is None
        assert app.state.registry.reveal_node_token(node['id']) is None
        assert token


@pytest.mark.parametrize('failure', [RuntimeError, ValueError, KeyError])
def test_event_store_failures_are_retryable(monkeypatch, failure):
    monkeypatch.setenv('RELAY_ADMIN_TOKEN', 'admin_token')
    with TemporaryDirectory() as root:
        app = create_app(root)
        def fail(*args):
            raise failure('private database detail')
        monkeypatch.setattr(app.state.registry, 'handle_event', fail)
        response = TestClient(app).post('/api/v1/daemon-nodes/test/events', json={
            'type': 'run.output', 'commandId': 'cmd', 'sessionId': 'ses',
            'runId': 'run', 'agent': 'codex', 'stream': 'stdout', 'text': 'hello', 'sequence': 0,
        })
        assert response.status_code == 503
        assert 'private database detail' not in response.text


def test_malformed_event_is_permanent(monkeypatch):
    monkeypatch.setenv('RELAY_ADMIN_TOKEN', 'admin_token')
    with TemporaryDirectory() as root:
        response = TestClient(create_app(root)).post('/api/v1/daemon-nodes/test/events', json={'type': 'invalid'})
        assert response.status_code == 400


@pytest.mark.parametrize('lease', [90, 600, 3600])
def test_heartbeat_forwards_requested_lease(monkeypatch, lease):
    monkeypatch.setenv('RELAY_ADMIN_TOKEN', 'admin_token')
    with TemporaryDirectory() as root:
        app = create_app(root)
        observed = []
        def heartbeat(*args, **kwargs):
            observed.append(kwargs.get('lease_seconds', 60))
            return {}
        monkeypatch.setattr(app.state.registry, 'heartbeat', heartbeat)
        response = TestClient(app).post('/api/v1/daemon-nodes/test/heartbeat', json={'leaseSeconds': lease})
        assert response.status_code == 200
        assert observed == [lease]


@pytest.mark.parametrize('lease', [0, 3601, {}, True, 'NaN'])
def test_invalid_heartbeat_lease_is_rejected(monkeypatch, lease):
    monkeypatch.setenv('RELAY_ADMIN_TOKEN', 'admin_token')
    with TemporaryDirectory() as root:
        app = create_app(root)
        monkeypatch.setattr(app.state.registry, 'heartbeat', lambda *args, **kwargs: {})
        response = TestClient(app).post('/api/v1/daemon-nodes/test/heartbeat', json={'leaseSeconds': lease})
        assert response.status_code == 400


def test_anonymous_registration_cannot_create_a_computer(monkeypatch):
    monkeypatch.setenv('RELAY_ADMIN_TOKEN', 'admin_token')
    with TemporaryDirectory() as root:
        app = create_app(root)
        response = TestClient(app).post('/api/v1/daemon-node-registrations', json={
            'sandboxId': 'sbx_unprovisioned', 'token': 'self-picked-token',
            'protocolVersion': 1, 'supportedAgents': ['codex'], 'workspacePath': '/workspace',
        })
        assert response.status_code == 401
        assert app.state.registry.get('sbx_unprovisioned') is None
