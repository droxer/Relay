"""Heartbeat cost bounds and authoritative control-state checks."""
from concurrent.futures import ThreadPoolExecutor
from threading import Barrier

import pytest
from sqlalchemy import event, update

from relay.core.daemon_records import NODE_POLL_DRAINED_AT
from relay.core.ids import new_database_id
from relay.daemon_registry.credentials import hash_daemon_node_token
from relay.daemon_registry.records import DeletedDaemonNodeError, UnknownDaemonNodeError
from relay.daemon_registry.registry import DaemonNodeRegistry
from relay.persistence.db_time import require_db_time
from store_fixtures import make_daemon_store, make_session_store


def setup_registry(root):
    store = make_daemon_store(root)
    registry = DaemonNodeRegistry(make_session_store(root), store)
    registry.register({
        'sandboxId': 'heartbeat-load', 'token': 'test-node-token',
        'protocolVersion': 1, 'supportedAgents': ['codex'],
        'capabilities': ['workspace-scope', 'thread-workspaces'],
    })
    return registry, store


def capture(store):
    statements = []
    event.listen(store.engine, 'before_cursor_execute',
                 lambda _conn, _cursor, sql, *_args: statements.append(sql.lower()))
    return statements


def test_idle_heartbeat_never_loads_inventory_or_clears_configuration(tmp_path):
    registry, store = setup_registry(tmp_path)
    registry.sandboxes['heartbeat-load']['agentInventory'] = [{'kind': 'codex'}]
    statements = capture(store)
    registry.heartbeat('heartbeat-load', 'test-node-token')
    assert not any('daemon_node_agents' in sql for sql in statements)
    assert not any('daemon_nodes.capabilities' in sql for sql in statements)
    assert registry.sandboxes['heartbeat-load']['agents']['codex'] == 'ready'
    assert registry.sandboxes['heartbeat-load']['agentInventory'] == [{'kind': 'codex'}]


def test_replicas_share_seen_throttle_and_preserve_poll_clock(tmp_path):
    first, store = setup_registry(tmp_path)
    second = DaemonNodeRegistry(make_session_store(tmp_path), make_daemon_store(tmp_path))
    with store.engine.begin() as conn:
        conn.execute(update(store.nodes).values(last_seen_at=None, last_poll_at=None))
    statements = capture(store)
    for replica in [first, second] * 4:
        replica.heartbeat('heartbeat-load', 'test-node-token')
    writes = [sql for sql in statements if sql.startswith('update daemon_nodes')]
    # Subsequent authoritative reads see a fresh stamp and skip the UPDATE.
    assert len(writes) == 1
    first.take_commands('heartbeat-load', 'test-node-token', renew_known_active=False)
    assert store.get_node('heartbeat-load')['lastPollAt']


def test_fresh_authorized_heartbeat_reads_once_without_a_write(tmp_path):
    registry, store = setup_registry(tmp_path)
    registry.heartbeat('heartbeat-load', 'test-node-token')
    statements = capture(store)
    registry.heartbeat('heartbeat-load', 'test-node-token')
    sql = [statement for statement in statements if not statement.startswith('begin')]
    assert len(sql) == 1
    assert sql[0].startswith('select')


def test_failed_persistence_does_not_suppress_next_attempt(tmp_path, monkeypatch):
    registry, store = setup_registry(tmp_path)
    with store.engine.begin() as conn:
        conn.execute(update(store.nodes).values(last_seen_at=None))
    original = store.touch_node_observation

    def fail(*_args, **_kwargs):
        raise RuntimeError('injected database failure')

    monkeypatch.setattr(store, 'touch_node_observation', fail)
    with pytest.raises(RuntimeError, match='injected'):
        registry.heartbeat('heartbeat-load', 'test-node-token')
    monkeypatch.setattr(store, 'touch_node_observation', original)
    registry.heartbeat('heartbeat-load', 'test-node-token')
    assert store.get_node('heartbeat-load')['lastSeenAt']


@pytest.mark.parametrize('change', ['token', 'deleted', 'retired', 'drained'])
def test_control_change_between_read_and_touch_is_not_overwritten(tmp_path, monkeypatch, change):
    registry, store = setup_registry(tmp_path)
    with store.engine.begin() as conn:
        conn.execute(update(store.nodes).values(last_seen_at=None))
    original = store.touch_node_observation

    def change_then_touch(observed, **kwargs):
        values = {
            'token': {'node_token_hash': hash_daemon_node_token('replacement'), 'credential_version': 2},
            'deleted': {'status': 'deleted'},
            'retired': {'retired_at': require_db_time('2026-01-01T00:00:00Z')},
            'drained': {'last_poll_at': require_db_time(NODE_POLL_DRAINED_AT)},
        }[change]
        with store.engine.begin() as conn:
            conn.execute(update(store.nodes).values(**values))
        return original(observed, **kwargs)

    monkeypatch.setattr(store, 'touch_node_observation', change_then_touch)
    if change == 'drained':
        registry.heartbeat('heartbeat-load', 'test-node-token')
        assert store.get_node('heartbeat-load')['lastPollAt'] == NODE_POLL_DRAINED_AT
    else:
        with pytest.raises(DeletedDaemonNodeError if change == 'deleted' else PermissionError):
            registry.heartbeat('heartbeat-load', 'test-node-token')
        assert store.get_node('heartbeat-load').get('lastSeenAt') is None


@pytest.mark.parametrize('change', ['token', 'deleted', 'retired', 'missing'])
def test_heartbeat_always_reads_current_authorization(tmp_path, change):
    registry, store = setup_registry(tmp_path)
    registry.heartbeat('heartbeat-load', 'test-node-token')
    with store.engine.begin() as conn:
        if change == 'missing':
            conn.execute(store.nodes.delete())
        else:
            values = {
                'token': {'node_token_hash': hash_daemon_node_token('replacement')},
                'deleted': {'status': 'deleted'},
                'retired': {'retired_at': require_db_time('2026-01-01T00:00:00Z')},
            }[change]
            conn.execute(update(store.nodes).values(**values))
    error = {'deleted': DeletedDaemonNodeError, 'missing': UnknownDaemonNodeError}.get(change, PermissionError)
    with pytest.raises(error):
        registry.heartbeat('heartbeat-load', 'test-node-token')


def test_active_heartbeat_batches_command_observations(tmp_path):
    registry, store = setup_registry(tmp_path)
    leases = []
    for _ in range(4):
        store.enqueue_command('heartbeat-load', {'id': new_database_id(), 'type': 'runtime.refresh'})
    for record in store.take_queued_commands('heartbeat-load'):
        leases.append((record['id'], record['leaseId']))
    statements = capture(store)
    result = registry.heartbeat('heartbeat-load', 'test-node-token', leases)
    command_reads = [sql for sql in statements if sql.startswith('select') and 'from daemon_commands' in sql]
    # One renewal lookup plus one batch of the persisted post-renewal records.
    assert len(command_reads) <= 2
    assert {item['commandId'] for item in result['commandLeases']} == {key for key, _ in leases}
    for item in result['commandLeases']:
        assert item['leaseExpiresAt'] == store.get_command(item['commandId'])['leaseExpiresAt']


def test_mismatched_lease_cannot_record_progress(tmp_path, monkeypatch):
    registry, store = setup_registry(tmp_path)
    store.enqueue_command('heartbeat-load', {'id': new_database_id(), 'type': 'runtime.refresh'})
    [record] = store.take_queued_commands('heartbeat-load')
    progress = []
    monkeypatch.setattr(registry, '_note_run_progress', progress.append)
    result = registry.heartbeat('heartbeat-load', 'test-node-token', [(record['id'], 'superseded')])
    assert result['commandLeases'] == []
    assert progress == []


def test_store_observation_compare_and_set_fences_control_changes(tmp_path):
    _registry, store = setup_registry(tmp_path)
    before = store.get_node_observation('heartbeat-load')
    with store.engine.begin() as conn:
        conn.execute(update(store.nodes).values(last_poll_at=require_db_time(NODE_POLL_DRAINED_AT)))
    after = store.touch_node_observation(before, interval_seconds=5, polled=True)
    assert after['lastPollAt'] == NODE_POLL_DRAINED_AT
    assert store.get_node('heartbeat-load')['lastPollAt'] == NODE_POLL_DRAINED_AT


def test_simultaneous_observations_share_durable_due_predicate(tmp_path):
    _registry, store = setup_registry(tmp_path)
    other = make_daemon_store(tmp_path)
    with store.engine.begin() as conn:
        conn.execute(update(store.nodes).values(last_seen_at=None))
    observations = [item.get_node_observation('heartbeat-load') for item in [store, other]]
    barrier = Barrier(2)

    def touch(pair):
        backend, observation = pair
        barrier.wait(timeout=10)
        return backend.touch_node_observation(observation, interval_seconds=5)

    with ThreadPoolExecutor(2) as pool:
        results = list(pool.map(touch, zip([store, other], observations, strict=True)))
    assert results[0]['lastSeenAt'] == results[1]['lastSeenAt']
