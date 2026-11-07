"""Project tool pages must bound database hydration, not only the returned JSON."""

import test_project_manager_api as manager_api
import test_project_setup_api as setup_api

setup_env = setup_api.setup_env
managed_env = manager_api.managed_env


def test_project_pages_filter_before_hydration_and_keep_unicode_search(managed_env, monkeypatch):
    app, owner, node, project, *_ = managed_env
    _, command = manager_api._start(managed_env)
    other = owner.post('/api/v1/projects', json={
        'name': 'Unrelated', 'daemonNodeId': node['id'], 'members': [],
    }).json()['project']
    for i in range(6):
        reply = owner.post('/api/v1/tasks', json={
            'title': f'Straße {i}', 'projectId': project['id'] if i < 4 else other['id'],
        })
        assert reply.status_code == 201, reply.text

    def unbounded(*_args, **_kwargs):
        raise AssertionError('Project tools must not load all owner tasks or complete histories')

    monkeypatch.setattr(app.state.task_store, 'list_task_summaries', unbounded)
    monkeypatch.setattr(app.state.task_store, 'get_task', unbounded)
    monkeypatch.setattr(app.state.session_store, 'get_session', unbounded)
    monkeypatch.setattr(app.state.session_store, 'list_session_snapshots', unbounded)
    monkeypatch.setattr(app.state.project_store, 'events', unbounded)
    first = manager_api._tool(managed_env, command, 'tasks', {'limit': 2, 'query': 'STRASSE'} )
    assert first.status_code == 200, first.text
    first = first.json()
    assert first['total'] == 4
    assert len(first['tasks']) == 2
    second = manager_api._tool(managed_env, command, 'tasks', {
        'limit': 2, 'query': 'STRASSE', 'cursor': first['nextCursor'],
    }).json()
    assert len(second['tasks']) == 2 and second['nextCursor'] is None
    assert {t['id'] for t in first['tasks']}.isdisjoint(t['id'] for t in second['tasks'])
    overview = manager_api._tool(managed_env, command, 'overview')
    assert overview.status_code == 200, overview.text
    assert overview.json()['total'] == 4
    activity = manager_api._tool(managed_env, command, 'activity', {'limit': 2})
    assert activity.status_code == 200, activity.text
    page = activity.json()
    assert len(page['events']) == 2 and page['nextCursor'] == 2
    seen = []
    while True:
        seen.extend(page['events'])
        if page['nextCursor'] is None:
            break
        page = manager_api._tool(managed_env, command, 'activity', {
            'limit': 2, 'cursor': page['nextCursor'], 'cutoff': page['cutoff'],
        }).json()
    assert len(seen) == page['total']
    assert len([e for e in seen if e.get('taskId')]) == 4
