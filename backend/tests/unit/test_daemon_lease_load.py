"""Frequent health probes must not rewrite durable leases or grow the event log."""
from datetime import UTC, datetime, timedelta

from sqlalchemy import event

from relay.core.ids import new_database_id
from relay.persistence.daemon import commands as command_rows
from store_fixtures import make_daemon_store


def test_lease_renewals_are_throttled_across_store_instances(tmp_path, monkeypatch):
    store = make_daemon_store(tmp_path)
    store.register_node({'id': 'node', 'status': 'ready', 'agents': {},
                         'createdAt': '2026-01-01T00:00:00Z', 'updatedAt': '2026-01-01T00:00:00Z'})
    clock = [datetime(2026, 11, 10, tzinfo=UTC)]
    monkeypatch.setattr(command_rows, 'now_iso', lambda: clock[0].isoformat())
    leases = []
    for _ in range(2):
        command = {'id': new_database_id(), 'type': 'run.start', 'sessionId': 'session',
                   'runId': new_database_id(), 'agent': 'codex', 'taskGoal': 'test'}
        store.enqueue_command('node', command)
    for record in store.take_queued_commands('node', lease_seconds=90):
        leases.append((record['id'], record['leaseId']))
    # First explicit acknowledgement fences recovery/redelivery immediately.
    store.renew_command_leases('node', leases, lease_seconds=90)
    assert all(store.get_command(key)['command']['_deliveryAcknowledged'] for key, _ in leases)
    original = [store.get_command(key)['leaseExpiresAt'] for key, _ in leases]
    statements = []
    event.listen(store.engine, 'before_cursor_execute',
                 lambda _conn, _cursor, sql, *_args: statements.append(sql.lower()))
    replica = make_daemon_store(tmp_path)
    for second in range(1, 30):
        clock[0] = datetime(2026, 11, 10, tzinfo=UTC) + timedelta(seconds=second)
        replica.renew_command_leases('node', leases, lease_seconds=90)
    assert [store.get_command(key)['leaseExpiresAt'] for key, _ in leases] == original
    assert not any(sql.startswith(('update ', 'insert ')) for sql in statements)
    statements.clear()
    clock[0] += timedelta(seconds=2)
    replica.renew_command_leases('node', leases, lease_seconds=90)
    assert all(store.get_command(key)['leaseExpiresAt'] > prior for (key, _), prior in zip(leases, original, strict=True))
    # One batch writes the due leases; routine renewal isn't an audit event.
    assert len([sql for sql in statements if sql.startswith('update ')]) == 1
    assert not any(sql.startswith('insert ') for sql in statements)
    before = store.get_command(leases[0][0])['leaseExpiresAt']
    clock[0] += timedelta(seconds=40)
    store.renew_command_leases('node', [(leases[0][0], 'superseded')], lease_seconds=90)
    store.register_node({'id': 'another-node', 'status': 'ready', 'agents': {},
                         'createdAt': clock[0].isoformat(), 'updatedAt': clock[0].isoformat()})
    store.renew_command_leases('another-node', leases, lease_seconds=90)
    assert store.get_command(leases[0][0])['leaseExpiresAt'] == before
