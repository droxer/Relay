"""Unscoped storage cannot bypass private Task, Thread, or Project access."""
from __future__ import annotations

import pytest
from fastapi.testclient import TestClient
from relay.app import create_app

from test_tasks import _bootstrap_admin, _create_account, _login


@pytest.mark.parametrize('computer_owner', ['admin', 'alice', None])
@pytest.mark.parametrize('suffix', ['files', 'file?path=projects/private/secret.txt'])
def test_admin_cannot_browse_an_unscoped_computer_root(monkeypatch, tmp_path, computer_owner, suffix):
    monkeypatch.setenv('RELAY_ADMIN_TOKEN', 'admin_token')
    app = create_app(tmp_path)
    client = TestClient(app)
    _bootstrap_admin(client)
    app.state.registry.register({
        'sandboxId': 'node_1', 'userId': app.state.auth_store.resolve_user_id('admin') if computer_owner == 'admin' else computer_owner,
        'token': 'node_token', 'protocolVersion': 1, 'supportedAgents': ['codex'],
        'capabilities': ['workspace-read-shared'], 'status': 'ready',
    })

    async def dispatch(*_args):
        pytest.fail('An unscoped storage read must never reach the daemon')

    monkeypatch.setattr('relay.api.computers.workspace_transport.dispatch_workspace_command', dispatch)
    response = client.get(f'/api/v1/admin/daemon-nodes/node_1/workspace/{suffix}')
    assert response.status_code == 403, response.text
    assert 'owning task, thread, or project' in response.json()['detail']


def test_unscoped_storage_routes_still_require_authentication(monkeypatch, tmp_path):
    monkeypatch.setenv('RELAY_ADMIN_TOKEN', 'admin_token')
    app = create_app(tmp_path)
    client = TestClient(app)
    _bootstrap_admin(client)
    _create_account(client, 'alice', user_id='alice')
    for suffix in ('files', 'file?path=secret.txt'):
        assert TestClient(app).get(f'/api/v1/admin/daemon-nodes/missing/workspace/{suffix}').status_code == 401
    _login(client, 'alice')
    for suffix in ('files', 'file?path=secret.txt'):
        assert client.get(f'/api/v1/admin/daemon-nodes/missing/workspace/{suffix}').status_code == 403
