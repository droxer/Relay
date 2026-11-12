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


@pytest.mark.parametrize('failure', [RuntimeError, ValueError, TypeError, KeyError])
def test_failed_replay_group_rolls_back_and_does_not_starve_another_run(tmp_path, monkeypatch, failure):
    import json
    from relay.api.computers.daemon_reports import _accept_batch
    registry, sessions, first = fixture(tmp_path)
    _, _, second = fixture(tmp_path)
    original = registry.handle_durable_report
    def fail_after_ingest(node_id, event, token, report_id, digest):
        original(node_id, event, token, report_id, digest)
        if event['commandId'] == first['commandId']:
            raise failure('injected failure before group commit')
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


@pytest.mark.parametrize('invalid, status, detail', [
    ({'agent': ''}, 400, 'requires commandId'),
    ({'leaseId': 'wrong'}, 409, 'ownership'),
])
def test_batch_rejection_includes_actionable_reason_without_acceptance(tmp_path, invalid, status, detail):
    import json
    from relay.api.computers.daemon_reports import _accept_batch
    registry, _, event = fixture(tmp_path)
    body = json.dumps({**event, **invalid})
    report = {'id': '0' * 64, 'digest': sha256(body.encode()).hexdigest(), 'body': body}
    [receipt] = _accept_batch(registry, 'node', 'secret', [report])
    assert receipt['status'] == status
    assert detail in receipt['detail']
    assert not registry.daemon_store.report_was_accepted('node', event['commandId'], report['id'], report['digest'])


@pytest.mark.parametrize("terminal_type", ["run.completed", "run.failed", "run.cancelled"])
def test_retention_preserves_pending_replay_then_prunes_after_final_sequence(tmp_path, terminal_type):
    registry, sessions, event = fixture(tmp_path)
    terminal = {key: value for key, value in event.items() if key not in ("stream", "sequence", "text", "replayed")}
    terminal.update(type=terminal_type, exitCode=0, lastOutputSequence=1)
    registry.handle_durable_report("node", terminal, "secret", "a" * 64, "b" * 64)
    for sequence in range(2):
        counts = registry.daemon_store.prune_terminal_records(0, 0)
        assert counts["commands"] == counts["runs"] == 0
        registry.handle_durable_report("node", {**event, "sequence": sequence}, "secret", str(sequence) * 64, "c" * 64)
    assert registry.daemon_store.prune_terminal_records(0, 0)["commands"] == 1
    assert len([item for item in sessions.get_session(event["sessionId"])["events"] if item["type"] == "agent.output"]) == 2


def test_legacy_durable_completion_without_watermark_remains_replayable(tmp_path):
    registry, _, event = fixture(tmp_path)
    terminal = {key: value for key, value in event.items() if key not in ("stream", "sequence", "text", "replayed")}
    registry.handle_durable_report("node", {**terminal, "type": "run.completed", "exitCode": 0}, "secret", "a" * 64, "b" * 64)
    assert registry.daemon_store.prune_terminal_records(0, 0)["commands"] == 0
    registry.handle_durable_report("node", event, "secret", "c" * 64, "d" * 64)


@pytest.mark.parametrize("wire", ["events", "reports"])
def test_rejected_verdict_reason_survives_http_ingestion(tmp_path, monkeypatch, wire):
    from dataclasses import replace
    import json
    from fastapi.testclient import TestClient
    from relay.app import create_app
    registry, _, event = fixture(tmp_path)
    captured = []
    original = registry._claim_and_advance_run_request
    def observe(terminal):
        captured.append(terminal)
        return original(terminal)
    monkeypatch.setattr(registry, "_claim_and_advance_run_request", observe)
    app = create_app(str(tmp_path / "app"))
    app.state.context = replace(app.state.context, registry=registry)
    terminal = {key: value for key, value in event.items() if key not in ("stream", "sequence", "text", "replayed")}
    terminal.update(type="run.completed", exitCode=0, roundResultRejected={"reason": "run_id_mismatch"}, lastOutputSequence=-1)
    raw = json.dumps(terminal)
    report_id, digest = "a" * 64, sha256(raw.encode()).hexdigest()
    headers = {"Authorization": "Bearer secret", "Content-Type": "application/json"}
    client = TestClient(app)
    if wire == "events":
        response = client.post("/api/v1/daemon-nodes/node/events", content=raw,
                               headers={**headers, "X-Relay-Report-Id": report_id, "X-Relay-Report-Digest": digest})
    else:
        response = client.post("/api/v1/daemon-nodes/node/reports", headers=headers,
                               json={"reports": [{"id": report_id, "digest": digest, "body": raw}]})
        assert response.json()["receipts"][0]["status"] == 200
    assert response.status_code == 200, response.text
    assert captured[0]["roundResultRejected"] == {"reason": "run_id_mismatch"}
    assert captured[0]["lastOutputSequence"] == -1
    assert registry.daemon_store.prune_terminal_records(0, 0)["commands"] == 1


@pytest.mark.parametrize("wire", ["events", "reports"])
@pytest.mark.parametrize("kind", ["terminal", "output"])
@pytest.mark.parametrize("delete_thread", [False, True])
def test_lost_acknowledgement_survives_command_pruning(tmp_path, wire, kind, delete_thread):
    import json
    from dataclasses import replace
    from fastapi.testclient import TestClient
    from relay.app import create_app
    from relay.persistence.tables.daemon_reports import report_receipts
    from sqlalchemy import select
    registry, sessions, output = fixture(tmp_path)
    terminal = {key: value for key, value in output.items() if key not in ("stream", "sequence", "text", "replayed")}
    terminal.update(type="run.completed", exitCode=0, lastOutputSequence=0)
    reports = []
    for index, event in enumerate((output, terminal)):
        raw = json.dumps(event)
        report_id = str(index) * 64
        digest = sha256(raw.encode()).hexdigest()
        registry.handle_durable_report("node", event, "secret", report_id, digest)
        reports.append({"id": report_id, "digest": digest, "body": raw})
    report = reports[1 if kind == "terminal" else 0]
    assert registry.daemon_store.prune_terminal_records(0, 0)["commands"] == 1
    with registry.daemon_store.engine.connect() as conn:
        assert conn.scalar(select(report_receipts.c.report_id).where(report_receipts.c.report_id == report["id"])) == report["id"]
    before = sessions.get_session(output["sessionId"])["events"]
    if delete_thread:
        sessions.delete_session(output["sessionId"])
    app = create_app(str(tmp_path / "app"))
    app.state.context = replace(app.state.context, registry=registry)
    client = TestClient(app)
    headers = {"Authorization": "Bearer secret", "Content-Type": "application/json"}
    if wire == "events":
        response = client.post("/api/v1/daemon-nodes/node/events", content=report["body"], headers={
            **headers, "X-Relay-Report-Id": report["id"], "X-Relay-Report-Digest": report["digest"]})
        assert response.status_code == 200, response.text
        assert response.headers["X-Relay-Report-Digest"] == report["digest"]
    else:
        response = client.post("/api/v1/daemon-nodes/node/reports", json={"reports": [report]}, headers=headers)
        assert response.status_code == 200, response.text
        assert response.json()["receipts"][0]["status"] == 200
    if not delete_thread:
        assert sessions.get_session(output["sessionId"])["events"] == before
    registry.register({"sandboxId": "other", "userId": registry.get("node")["userId"], "token": "other-secret",
                       "workspacePath": "/other", "protocolVersion": 2, "supportedAgents": ["codex"]})
    with pytest.raises(CommandEventMismatchError):
        registry.handle_durable_report("other", output, "other-secret", report["id"], report["digest"])
    with pytest.raises(CommandEventMismatchError):
        registry.handle_durable_report("node", output, "secret", "e" * 64, report["digest"])
    with pytest.raises(CommandEventMismatchError):
        registry.handle_durable_report("node", output if kind == "output" else terminal,
                                       "secret", report["id"], "f" * 64)
    with pytest.raises(PermissionError):
        registry.handle_durable_report("node", output, "wrong", report["id"], report["digest"])


@pytest.mark.parametrize('terminal', ['completed', 'failed'])
@pytest.mark.parametrize('durable', [False, True])
def test_cancellation_ack_after_exit_settles_stop_without_rewriting_outcome(tmp_path, terminal, durable):
    registry, sessions, output = fixture(tmp_path)
    event = {key: value for key, value in output.items()
             if key not in ('stream', 'sequence', 'text', 'replayed')}
    store = registry.daemon_store
    registry.handle_event('node', {**event, 'type': f'run.{terminal}', 'exitCode': 0, 'error': 'failed'}, 'secret')
    before = sessions.get_session(event['sessionId'])
    target_before = store.get_command(event['commandId'])
    cancel = {'id': new_database_id(), 'type': 'run.cancel',
              'commandId': event['commandId'], 'sessionId': event['sessionId'],
              'runId': event['runId'], 'agent': event['agent'], 'reason': 'stop',
              'targetLeaseId': event['leaseId']}
    store.enqueue_command('node', cancel)
    store.take_queued_commands('node')
    ack = {**event, 'type': 'run.cancelled', 'reason': 'not executing'}
    if durable:
        registry.handle_durable_report('node', ack, 'secret', 'a' * 64, 'b' * 64)
    else:
        registry.handle_event('node', ack, 'secret')
    assert store.get_command(cancel['id'])['status'] == 'completed'
    assert store.get_command(event['commandId']) == target_before
    assert sessions.get_session(event['sessionId']) == before
    store.prune_terminal_records(retention_seconds=0, per_node_limit=0)
    assert store.take_queued_commands('node') == []


def test_retention_preserves_exit_authority_until_stop_is_acknowledged(tmp_path):
    registry, _, output = fixture(tmp_path)
    store = registry.daemon_store
    event = {key: value for key, value in output.items()
             if key not in ('stream', 'sequence', 'text', 'replayed')}
    registry.handle_event('node', {**event, 'type': 'run.completed', 'exitCode': 0}, 'secret')
    cancel = {'id': new_database_id(), 'type': 'run.cancel',
              'commandId': event['commandId'], 'sessionId': event['sessionId'],
              'runId': event['runId'], 'agent': event['agent'], 'reason': 'stop',
              'targetLeaseId': event['leaseId']}
    store.enqueue_command('node', cancel)
    store.take_queued_commands('node')
    store.prune_terminal_records(retention_seconds=0, per_node_limit=0)
    assert store.get_command(event['commandId']) is not None
    registry.handle_durable_report('node', {**event, 'type': 'run.cancelled'}, 'secret', 'a' * 64, 'b' * 64)
    assert store.get_command(cancel['id'])['status'] == 'completed'
    store.prune_terminal_records(retention_seconds=0, per_node_limit=0)
    assert store.get_command(event['commandId']) is None


@pytest.mark.parametrize('terminal_type', ['run.completed', 'run.failed'])
def test_retained_completed_command_ack_survives_thread_deletion(tmp_path, terminal_type):
    registry, sessions, output = fixture(tmp_path)
    store = registry.daemon_store
    event = {key: value for key, value in output.items()
             if key not in ('stream', 'sequence', 'text', 'replayed')}
    registry.handle_event('node', {**event, 'type': terminal_type, 'exitCode': 0}, 'secret')
    cancel = {'id': new_database_id(), 'type': 'run.cancel',
              'commandId': event['commandId'], 'sessionId': event['sessionId'],
              'runId': event['runId'], 'agent': event['agent'], 'reason': 'stop',
              'targetLeaseId': event['leaseId']}
    store.enqueue_command('node', cancel)
    store.take_queued_commands('node')
    sessions.delete_session(event['sessionId'])
    with pytest.raises(CommandEventMismatchError, match='ownership'):
        registry.handle_durable_report('node', {**event, 'type': 'run.cancelled', 'leaseId': 'wrong'}, 'secret', 'c' * 64, 'd' * 64)
    assert store.get_command(cancel['id'])['status'] == 'dispatched'
    registry.handle_durable_report('node', {**event, 'type': 'run.cancelled'}, 'secret', 'a' * 64, 'b' * 64)
    assert store.get_command(cancel['id'])['status'] == 'completed'
    assert store.report_was_accepted('node', event['commandId'], 'a' * 64, 'b' * 64)


def orphaned_stop(tmp_path, *, leased=True):
    registry, sessions, output = fixture(tmp_path)
    store = registry.daemon_store
    event = {key: value for key, value in output.items()
             if key not in ('stream', 'sequence', 'text', 'replayed')}
    registry.handle_event('node', {**event, 'type': 'run.completed', 'exitCode': 0}, 'secret')
    # Recreate historical data: retention already removed the target before
    # the still-live cancellation was acknowledged.
    store.prune_terminal_records(retention_seconds=0, per_node_limit=0)
    assert store.get_command(event['commandId']) is None
    if not leased:
        event.pop('leaseId')
    cancel = {'id': new_database_id(), 'type': 'run.cancel',
              'commandId': event['commandId'], 'sessionId': event['sessionId'],
              'runId': event['runId'], 'agent': event['agent'], 'reason': 'stop',
              **({'targetLeaseId': event['leaseId']} if leased else {})}
    store.enqueue_command('node', cancel)
    store.take_queued_commands('node')
    return registry, sessions, {**event, 'type': 'run.cancelled'}, cancel


@pytest.mark.parametrize('leased', [False, True])
def test_orphaned_stop_ack_is_accepted_from_cancellation_authority(tmp_path, leased):
    registry, sessions, event, cancel = orphaned_stop(tmp_path, leased=leased)
    before = sessions.get_session(event['sessionId'])
    registry.handle_durable_report('node', event, 'secret', 'a' * 64, 'b' * 64)
    store = registry.daemon_store
    assert store.get_command(cancel['id'])['status'] == 'completed'
    assert sessions.get_session(event['sessionId']) == before
    assert store.report_was_accepted('node', event['commandId'], 'a' * 64, 'b' * 64)
    store.prune_terminal_records(retention_seconds=0, per_node_limit=0)
    registry.handle_durable_report('node', event, 'secret', 'a' * 64, 'b' * 64)
    assert store.take_queued_commands('node') == []
    with pytest.raises(CommandEventMismatchError, match='different owner or payload'):
        registry.handle_durable_report('node', event, 'secret', 'a' * 64, 'c' * 64)


@pytest.mark.parametrize('field,value', [
    ('commandId', '00000000-0000-4000-8000-000000000001'),
    ('sessionId', '00000000-0000-4000-8000-000000000002'),
    ('runId', '00000000-0000-4000-8000-000000000003'),
    ('agent', 'claude'), ('leaseId', 'wrong-lease'), ('leaseId', None),
    ('type', 'run.completed'),
])
def test_orphan_recovery_refuses_reports_without_matching_stop_authority(tmp_path, field, value):
    registry, _, event, cancel = orphaned_stop(tmp_path)
    with pytest.raises(CommandEventMismatchError, match='unknown command'):
        registry.handle_durable_report('node', {**event, field: value}, 'secret', 'a' * 64, 'b' * 64)
    assert registry.daemon_store.get_command(cancel['id'])['status'] == 'dispatched'
    assert not registry.daemon_store.report_was_accepted('node', event['commandId'], 'a' * 64, 'b' * 64)


def test_orphan_recovery_requires_the_owning_node_and_valid_credentials(tmp_path):
    registry, _, event, cancel = orphaned_stop(tmp_path)
    registry.register({'sandboxId': 'other', 'userId': registry.get('node')['userId'], 'token': 'other-secret',
                       'workspacePath': '/other', 'protocolVersion': 2, 'supportedAgents': ['codex']})
    with pytest.raises(CommandEventMismatchError, match='unknown command'):
        registry.handle_durable_report('other', event, 'other-secret', 'a' * 64, 'b' * 64)
    with pytest.raises(PermissionError):
        registry.handle_durable_report('node', event, 'wrong', 'a' * 64, 'b' * 64)
    assert registry.daemon_store.get_command(cancel['id'])['status'] == 'dispatched'


def test_orphan_recovery_rolls_back_stop_and_receipt_together(tmp_path, monkeypatch):
    registry, _, event, cancel = orphaned_stop(tmp_path)
    store = registry.daemon_store
    original = store.mark_cancel_commands_completed
    def fail_after_settling(node_id, target_id):
        original(node_id, target_id)
        raise RuntimeError('interrupted before receipt')
    monkeypatch.setattr(store, 'mark_cancel_commands_completed', fail_after_settling)
    with pytest.raises(RuntimeError, match='interrupted'):
        registry.handle_durable_report('node', event, 'secret', 'a' * 64, 'b' * 64)
    assert store.get_command(cancel['id'])['status'] == 'dispatched'
    assert not store.report_was_accepted('node', event['commandId'], 'a' * 64, 'b' * 64)
    monkeypatch.setattr(store, 'mark_cancel_commands_completed', original)
    registry.handle_durable_report('node', event, 'secret', 'a' * 64, 'b' * 64)
    assert store.get_command(cancel['id'])['status'] == 'completed'


@pytest.mark.parametrize('wire', ['events', 'reports'])
def test_orphaned_stop_recovery_survives_thread_deletion_over_http(tmp_path, wire):
    from dataclasses import replace
    import json
    from fastapi.testclient import TestClient
    from relay.app import create_app
    registry, sessions, event, cancel = orphaned_stop(tmp_path, leased=False)
    sessions.delete_session(event['sessionId'])
    app = create_app(str(tmp_path / 'app'))
    app.state.context = replace(app.state.context, registry=registry)
    client = TestClient(app)
    raw = json.dumps(event)
    digest = sha256(raw.encode()).hexdigest()
    headers = {'Authorization': 'Bearer secret', 'Content-Type': 'application/json'}
    if wire == 'events':
        response = client.post('/api/v1/daemon-nodes/node/events', content=raw, headers={
            **headers, 'X-Relay-Report-Id': 'a' * 64, 'X-Relay-Report-Digest': digest})
        assert response.headers.get('X-Relay-Report-Digest') == digest, response.text
    else:
        response = client.post('/api/v1/daemon-nodes/node/reports', headers=headers,
                               json={'reports': [{'id': 'a' * 64, 'digest': digest, 'body': raw}]})
        assert response.json()['receipts'][0]['status'] == 200
    assert response.status_code == 200, response.text
    assert registry.daemon_store.get_command(cancel['id'])['status'] == 'completed'
