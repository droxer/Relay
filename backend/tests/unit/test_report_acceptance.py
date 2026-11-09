"""Durable report receipts commit with effects, not merely HTTP success."""
from hashlib import sha256

import pytest
from relay.core.ids import new_database_id
from relay.daemon_registry.registry import DaemonNodeRegistry
from relay.daemon_registry.records import CommandEventMismatchError
from store_fixtures import make_auth_store, make_daemon_store, make_session_store


def fixture(tmp_path):
    sessions = make_session_store(tmp_path)
    daemons = make_daemon_store(tmp_path)
    registry = DaemonNodeRegistry(sessions, daemons)
    owner = make_auth_store(tmp_path).ensure_user("alice")["id"]
    registry.register({"sandboxId": "node", "userId": owner, "token": "secret",
                       "workspacePath": "/workspace", "protocolVersion": 2, "supportedAgents": ["codex"]})
    session = sessions.create_session({"workspacePath": "/workspace", "taskGoal": "test"})
    command = {"id": new_database_id(), "type": "run.start", "sessionId": session["id"],
               "runId": new_database_id(), "agent": "codex", "taskGoal": "test"}
    daemons.enqueue_command("node", command)
    [delivered] = daemons.take_queued_commands("node")
    event = {"type": "run.output", "commandId": command["id"], "sessionId": session["id"],
             "runId": command["runId"], "agent": "codex", "leaseId": delivered["leaseId"],
             "stream": "stdout", "sequence": 0, "text": "hello", "replayed": True}
    return registry, sessions, event


def test_report_receipt_is_durable_idempotent_and_payload_bound(tmp_path):
    registry, sessions, event = fixture(tmp_path)
    report_id = sha256(b'identity').hexdigest()
    digest = sha256(b'payload').hexdigest()
    registry.handle_durable_report("node", event, "secret", report_id, digest)
    registry.handle_durable_report("node", event, "secret", report_id, digest)
    output = [item for item in sessions.get_session(event['sessionId'])['events'] if item['type'] == 'agent.output']
    assert len(output) == 1
    with pytest.raises(CommandEventMismatchError):
        registry.handle_durable_report("node", {**event, "text": "changed"}, "secret", report_id, 'b' * 64)
    with pytest.raises(PermissionError):
        registry.handle_durable_report("node", event, "wrong", report_id, digest)


def test_two_registry_replicas_accept_one_effect_for_concurrent_copies(tmp_path):
    from concurrent.futures import ThreadPoolExecutor
    from threading import Barrier
    registry, sessions, event = fixture(tmp_path)
    if registry.daemon_store.engine.dialect.name != 'postgresql':
        pytest.skip('Cross-replica row locking requires PostgreSQL.')
    replica = DaemonNodeRegistry(make_session_store(tmp_path), make_daemon_store(tmp_path))
    barrier = Barrier(2)
    def accept(target):
        barrier.wait(timeout=10)
        target.handle_durable_report('node', event, 'secret', '0' * 64, 'b' * 64)
    with ThreadPoolExecutor(max_workers=2) as pool:
        list(pool.map(accept, (registry, replica)))
    output = [item for item in sessions.get_session(event['sessionId'])['events'] if item['type'] == 'agent.output']
    assert len(output) == 1


def test_terminal_receipt_commits_before_cross_resource_finalization(tmp_path, monkeypatch):
    from sqlalchemy import select
    from relay.persistence.tables.daemon_reports import report_receipts
    registry, _, event = fixture(tmp_path)
    if registry.daemon_store.engine.dialect.name != 'postgresql':
        pytest.skip('Independent commit visibility requires PostgreSQL.')
    visible = []
    def finalize(_event):
        with registry.daemon_store.engine.connect() as conn:
            visible.append(conn.scalar(select(report_receipts.c.report_id).where(report_receipts.c.command_id == event['commandId'])))
        return False
    monkeypatch.setattr(registry, '_claim_and_advance_run_request', finalize)
    terminal = {key: value for key, value in event.items() if key not in ('stream', 'sequence', 'text', 'replayed')}
    registry.handle_durable_report('node', {**terminal, 'type': 'run.completed', 'exitCode': 0}, 'secret', '0' * 64, 'b' * 64)
    assert visible == ['0' * 64]


def test_terminal_ingestion_excludes_local_heartbeat_before_database_locks(tmp_path, monkeypatch):
    from contextlib import contextmanager
    from threading import Event, Thread
    registry, _, event = fixture(tmp_path)
    acquired = Event()
    workers = []
    original = registry.daemon_store.report_ingest_scope
    def heartbeat_scope():
        with registry.dispatch_scope(['node']):
            acquired.set()
    @contextmanager
    def observed_scope(node_id):
        worker = Thread(target=heartbeat_scope, daemon=True)
        workers.append(worker)
        worker.start()
        # A competing heartbeat must wait before it can hold a local lock
        # while this request owns node/thread/command database rows.
        assert not acquired.wait(.05)
        with original(node_id):
            yield
    monkeypatch.setattr(registry.daemon_store, 'report_ingest_scope', observed_scope)
    terminal = {key: value for key, value in event.items() if key not in ('stream', 'sequence', 'text', 'replayed')}
    registry.handle_durable_report('node', {**terminal, 'type': 'run.completed', 'exitCode': 0}, 'secret', '0' * 64, 'b' * 64)
    for worker in workers:
        worker.join(timeout=2)
    assert acquired.is_set()


def test_missing_predecessor_is_retryable_and_does_not_consume_receipt(tmp_path):
    registry, sessions, event = fixture(tmp_path)
    with pytest.raises(ValueError, match='predecessor'):
        registry.handle_durable_report('node', {**event, 'sequence': 1}, 'secret', '1' * 64, 'a' * 64)
    registry.handle_durable_report('node', event, 'secret', '0' * 64, 'b' * 64)
    registry.handle_durable_report('node', {**event, 'sequence': 1}, 'secret', '1' * 64, 'a' * 64)
    output = [item for item in sessions.get_session(event['sessionId'])['events'] if item['type'] == 'agent.output']
    assert len(output) == 2


def test_failed_ingestion_rolls_back_receipt_and_cursor(tmp_path, monkeypatch):
    registry, sessions, event = fixture(tmp_path)
    original = sessions.append_event
    def fail(*args, **kwargs):
        raise RuntimeError('injected append failure')
    monkeypatch.setattr(sessions, 'append_event', fail)
    with pytest.raises(RuntimeError, match='injected'):
        registry.handle_durable_report('node', event, 'secret', '0' * 64, 'b' * 64)
    monkeypatch.setattr(sessions, 'append_event', original)
    registry.handle_durable_report('node', event, 'secret', '0' * 64, 'b' * 64)
    assert any(item['type'] == 'agent.output' for item in sessions.get_session(event['sessionId'])['events'])


def test_wire_requires_digest_and_returns_receipt_only_after_acceptance(tmp_path):
    from dataclasses import replace
    import json
    from fastapi.testclient import TestClient
    from relay.app import create_app
    registry, sessions, event = fixture(tmp_path)
    app = create_app(str(tmp_path / 'app'))
    app.state.context = replace(app.state.context, registry=registry)
    client = TestClient(app)
    raw = json.dumps(event)
    headers = {'Authorization': 'Bearer secret', 'Content-Type': 'application/json',
               'X-Relay-Report-Id': '0' * 64, 'X-Relay-Report-Digest': sha256(raw.encode()).hexdigest()}
    url = '/api/v1/daemon-nodes/node/events'
    result = client.post(url, content=raw, headers={**headers, 'X-Relay-Report-Digest': 'b' * 64})
    assert result.status_code == 400
    result = client.post(url, content=raw, headers=headers)
    assert result.status_code == 200, result.text
    assert result.headers['X-Relay-Report-Id'] == headers['X-Relay-Report-Id']
    assert result.headers['X-Relay-Report-Digest'] == headers['X-Relay-Report-Digest']


def test_transport_incident_updates_preserve_read_state_and_do_not_duplicate(tmp_path):
    from relay.persistence.notification.store import DatabaseNotificationStore
    from store_fixtures import sqlite_url
    store = DatabaseNotificationStore(sqlite_url(tmp_path), create_schema=True)
    rows = [{'user_id': 'alice', 'kind': 'computer_transport', 'dedupeKey': 'node/episode',
             'data': {'nodeId': 'node', 'causes': ['communication']}}]
    store.update_incident(rows)
    initial = store.list_for_user('alice')['notifications'][0]
    store.mark_read('alice', [initial['id']])
    rows[0]['data'] = {'nodeId': 'node', 'causes': [], 'recovered': True}
    store.update_incident(rows)
    notices = store.list_for_user('alice')['notifications']
    assert len(notices) == 1
    assert notices[0]['readAt'] is not None
    assert notices[0]['data']['recovered'] is True


@pytest.mark.parametrize(('owner', 'actor', 'allowed'), [
    ('alice', {'userId': 'alice', 'isAdmin': False}, True),
    ('alice', {'userId': 'bob', 'isAdmin': True}, False),
    ('alice', {'userId': 'bob', 'isAdmin': False}, False),
    (None, {'userId': 'admin', 'isAdmin': True}, True),
    (None, {'userId': 'bob', 'isAdmin': False}, False),
])
def test_transport_diagnostics_are_private_to_owner_or_shared_hardware_admin(monkeypatch, owner, actor, allowed):
    from types import SimpleNamespace
    from fastapi import HTTPException
    from relay.api.computers import daemon_wire
    monkeypatch.setattr(daemon_wire, 'request_actor', lambda *_args: actor)
    node = {'id': 'node', 'userId': owner}
    ctx = SimpleNamespace(auth_store=None, registry=SimpleNamespace(get=lambda _id: node),
                          daemon_store=SimpleNamespace(transport_status=lambda _id: {'state': 'healthy'}))
    if allowed:
        assert daemon_wire.computer_transport('node', None, ctx) == {'state': 'healthy'}
    else:
        with pytest.raises(HTTPException) as error:
            daemon_wire.computer_transport('node', None, ctx)
        assert error.value.status_code == 403


def test_storage_protected_poll_keeps_starts_queued_but_delivers_cancel(tmp_path):
    _, _, event = fixture(tmp_path)
    daemons = make_daemon_store(tmp_path)
    start = {'id': new_database_id(), 'type': 'run.start', 'sessionId': event['sessionId'], 'runId': new_database_id(), 'agent': 'codex', 'taskGoal': 'test'}
    cancel = {'id': new_database_id(), 'type': 'run.cancel', 'commandId': event['commandId'], 'sessionId': event['sessionId'], 'runId': event['runId'], 'agent': 'codex'}
    daemons.enqueue_command('node', start)
    daemons.enqueue_command('node', cancel)
    received = daemons.take_queued_commands('node', admit_runs=False)
    assert [item['id'] for item in received] == [cancel['id']]
    assert daemons.get_command(start['id'])['status'] == 'queued'


def test_batch_replay_preserves_each_report_identity(tmp_path):
    from dataclasses import replace
    import json
    from fastapi.testclient import TestClient
    from relay.app import create_app
    registry, _, event = fixture(tmp_path)
    app = create_app(str(tmp_path / 'app'))
    app.state.context = replace(app.state.context, registry=registry)
    client = TestClient(app)
    reports = []
    for sequence in range(3):
        body = json.dumps({**event, 'sequence': sequence})
        reports.append({'id': str(sequence) * 64, 'digest': sha256(body.encode()).hexdigest(), 'body': body})
    response = client.post('/api/v1/daemon-nodes/node/reports', headers={'Authorization': 'Bearer secret'}, json={'reports': reports})
    assert response.status_code == 200, response.text
    assert response.json()['receipts'] == [{'id': report['id'], 'digest': report['digest'], 'status': 200} for report in reports]


def test_lost_poll_response_redelivers_the_same_start_fence_until_acknowledged(tmp_path):
    registry, _, event = fixture(tmp_path)
    daemons = registry.daemon_store
    first = daemons.get_command(event['commandId'])
    recovered = daemons.recover_start_deliveries('node', limit=10, lease_seconds=60)
    assert [item['id'] for item in recovered] == [event['commandId']]
    assert recovered[0]['leaseId'] == first['leaseId']
    assert recovered[0]['attempt'] == first['attempt']
    daemons.renew_command_leases('node', [(event['commandId'], first['leaseId'])])
    assert daemons.recover_start_deliveries('node', limit=10, lease_seconds=60) == []


def test_failed_replay_group_rolls_back_and_does_not_starve_another_run(tmp_path, monkeypatch):
    import json
    from relay.api.computers.daemon_reports import _accept_batch
    registry, sessions, first = fixture(tmp_path)
    _, _, second = fixture(tmp_path)
    original = registry.handle_durable_report
    def fail_after_ingest(node_id, event, token, report_id, digest):
        original(node_id, event, token, report_id, digest)
        if event['commandId'] == first['commandId']:
            raise RuntimeError('injected failure before group commit')
    monkeypatch.setattr(registry, 'handle_durable_report', fail_after_ingest)
    reports = []
    for index, event in enumerate((first, second)):
        body = json.dumps(event)
        reports.append({'id': str(index) * 64, 'digest': sha256(body.encode()).hexdigest(), 'body': body})
    receipts = _accept_batch(registry, 'node', 'secret', reports)
    assert [receipt['status'] for receipt in receipts] == [500, 200]
    assert not any(item['type'] == 'agent.output' for item in sessions.get_session(first['sessionId'])['events'])
    monkeypatch.setattr(registry, 'handle_durable_report', original)
    assert _accept_batch(registry, 'node', 'secret', reports)[0]['status'] == 200
