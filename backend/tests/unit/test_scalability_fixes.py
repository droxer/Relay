"""Regression guarantees for the backend scalability review."""
import asyncio
import base64
import json
import threading
from types import SimpleNamespace

import pytest
from sqlalchemy import event, select, text

from relay.persistence.session_store import DatabaseSessionStore
from relay.persistence.store_common import relay_event


@pytest.mark.parametrize('endpoint', ['start_task', 'pickup_task'])
def test_task_dispatch_auth_does_not_run_on_event_loop(endpoint, monkeypatch):
    from relay.api import task_routes
    from fastapi import HTTPException
    from starlette.requests import Request

    async def run():
        loop_thread = threading.get_ident()
        def auth(*args):
            assert threading.get_ident() != loop_thread
            raise HTTPException(401)
        monkeypatch.setattr(task_routes, 'request_actor', auth)
        request = Request({'type': 'http', 'method': 'POST', 'headers': []})
        with pytest.raises(HTTPException):
            await getattr(task_routes, endpoint)(
                'test', request, SimpleNamespace(auth_store=None)
            )
    asyncio.run(run())


def test_stream_writes_exclude_old_logs_but_details_preserve_them(tmp_path):
    store = DatabaseSessionStore(f'sqlite:///{tmp_path}/sessions.db', create_schema=True)
    session = store.create_session({'taskGoal': 'history', 'workspacePath': '/work'})
    sid = session['id']
    log = 'x' * 262144
    store.append_event(sid, relay_event('agent.started', sid, {'runId': 'r', 'agent': 'codex'}))
    store.append_event(sid, relay_event('agent.completed', sid, {
        'runId': 'r', 'agent': 'codex', 'status': 'completed', 'exitCode': 0, 'agentLog': log,
    }))
    writes = []
    def capture(conn, cursor, statement, parameters, context, many):
        if statement.startswith('UPDATE sessions SET'):
            writes.append(sum(len(p) for p in parameters if isinstance(p, str)))
    event.listen(store.engine, 'before_cursor_execute', capture)
    store.append_event(sid, relay_event('agent.output', sid, {'runId': 'r2', 'agent': 'codex', 'text': 'y'}), hydrate_events=False)
    assert writes and max(writes) < 10000
    assert store.get_session(sid)['agentRuns'][0]['agentLog'] == log
    assert store.list_sessions()[0]['agentRuns'][0]['agentLog'] == log


def test_reconnect_cursor_has_index(tmp_path):
    store = DatabaseSessionStore(f'sqlite:///{tmp_path}/sessions.db', create_schema=True)
    session = store.create_session({'taskGoal': 'cursor', 'workspacePath': '/work'})
    first = session['events'][0]
    statements = []
    event.listen(store.engine, 'before_cursor_execute', lambda c, cur, s, p, ctx, many: statements.append((s, p)))
    assert store.read_event_page(session['id'], after_event_id=first['id'])['events'] == []
    cursor_sql, params = next((s, p) for s, p in statements if 'SELECT session_events.sequence' in s and 'payload' in s)
    with store.engine.connect() as conn:
        plan = conn.exec_driver_sql('EXPLAIN QUERY PLAN ' + cursor_sql, params).all()
    assert 'ix_session_events_cursor' in str(plan)


def test_managed_state_and_images_are_shared_between_replicas(tmp_path):
    from relay.persistence.managed_node_store import DatabaseManagedNodeStore
    from relay.persistence.profile_image_store import DatabaseProfileImageStore
    url = f'sqlite:///{tmp_path}/shared.db'
    a = DatabaseManagedNodeStore(url, create_schema=True)
    b = DatabaseManagedNodeStore(url, create_schema=True)
    node = a.create_node({'employeeId': 'alice'})
    assert b.get_node(node['id']) == node
    attempt, credential = a.create_attempt(node['id'])
    assert b.consume_enrollment_grant(credential) == (b.get_node(node['id']), attempt)
    b.complete_enrollment_grant(credential, 'runtime')
    with pytest.raises(PermissionError):
        a.complete_enrollment_grant(credential, 'other-runtime')
    with pytest.raises(ValueError):
        b.create_attempt(node['id'])
    images_a = DatabaseProfileImageStore(url, create_schema=True)
    images_b = DatabaseProfileImageStore(url, create_schema=True)
    content = b'\x89PNG\r\n\x1a\nimage'
    images_a.save('agents', 'agent', 'data:image/png;base64,' + base64.b64encode(content).decode())
    assert images_b.read('agents', 'agent')[0] == content
    images_b.delete('agents', 'agent')
    assert images_a.read('agents', 'agent') is None


def test_recovery_queries_are_bounded_in_sql(tmp_path):
    from relay.persistence.daemon_store import DatabaseDaemonStore
    store = DatabaseDaemonStore(f'sqlite:///{tmp_path}/daemon.db', create_schema=True)
    statements = []
    event.listen(store.engine, 'before_cursor_execute', lambda c, cur, s, p, ctx, many: statements.append(s))
    assert store.list_active_run_requests(limit=7, after_id=None) == []
    assert store.list_active_runs(limit=7, after_id=None) == []
    assert all('LIMIT' in s for s in statements if s.startswith('SELECT'))
