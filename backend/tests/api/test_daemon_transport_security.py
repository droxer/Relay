from tempfile import TemporaryDirectory

import pytest
from fastapi.testclient import TestClient
from relay.app import create_app
from sqlalchemy import text


def test_local_credentials_are_hash_only(monkeypatch):
    from relay.daemon_registry.registry import DaemonNodeRegistry
    from store_fixtures import make_daemon_store
    from store_fixtures import make_session_store
    monkeypatch.setenv('RELAY_ADMIN_TOKEN', 'admin_token')
    with TemporaryDirectory() as root:
        store = make_daemon_store(root)
        registry = DaemonNodeRegistry(make_session_store(root), store)
        node, _, token = registry.provision_pending('alice', '/workspace', 'none')
        assert not store.get_node(node['id']).get('nodeTokenSecret')
        with store.engine.connect() as conn:
            secret = conn.execute(text('SELECT node_token_secret FROM daemon_nodes')).scalar()
        assert secret is None
        assert registry.reveal_node_token(node['id']) is None
        assert token


def _transient_db_errors():
    from sqlalchemy.exc import InterfaceError, OperationalError
    from sqlalchemy.exc import TimeoutError as PoolTimeoutError
    return [
        OperationalError('SELECT 1', {}, Exception('private database detail')),
        InterfaceError('SELECT 1', {}, Exception('private database detail')),
        PoolTimeoutError('private database detail'),
    ]


def _post_failing_event(monkeypatch, root, error):
    app = create_app(root)
    def fail(*args):
        raise error
    monkeypatch.setattr(app.state.registry, 'handle_event', fail)
    return TestClient(app, raise_server_exceptions=False).post('/api/v1/daemon-nodes/test/events', json={
        'type': 'run.output.batch', 'commandId': 'cmd', 'sessionId': 'ses', 'runId': 'run',
        'agent': 'codex', 'entries': [{'stream': 'stdout', 'text': 'hello', 'sequence': 0}],
    })


@pytest.mark.parametrize('error', _transient_db_errors())
def test_transient_store_faults_answer_503(monkeypatch, error):
    # The daemon keeps the event durable and retries; a database blip loses nothing.
    monkeypatch.setenv('RELAY_ADMIN_TOKEN', 'admin_token')
    with TemporaryDirectory() as root:
        response = _post_failing_event(monkeypatch, root, error)
        assert response.status_code == 503
        assert 'private database detail' not in response.text


@pytest.mark.parametrize('failure', [RuntimeError, ValueError, KeyError])
def test_unexpected_event_failures_answer_500_and_stay_retryable(monkeypatch, failure):
    # A bug is not "temporarily unavailable": it answers 500 so the daemon's
    # retry warnings name it, yet stays 5xx so the durable event is replayed
    # once the fix ships rather than dropped.
    monkeypatch.setenv('RELAY_ADMIN_TOKEN', 'admin_token')
    with TemporaryDirectory() as root:
        response = _post_failing_event(monkeypatch, root, failure('private database detail'))
        assert response.status_code == 500
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


def test_unknown_node_event_is_a_permanent_rejection(monkeypatch):
    monkeypatch.setenv('RELAY_ADMIN_TOKEN', 'admin_token')
    with TemporaryDirectory() as root:
        response = TestClient(create_app(root)).post('/api/v1/daemon-nodes/missing/events', json={
            'type': 'run.output', 'commandId': 'cmd', 'sessionId': 'ses',
            'runId': 'run', 'agent': 'codex', 'stream': 'stdout', 'text': 'hello', 'sequence': 0,
        })
        assert response.status_code == 404
