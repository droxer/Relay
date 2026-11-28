"""A Team owns several reusable definitions without changing its roster."""
import pytest
from fastapi.testclient import TestClient

from task_setup import mark_task_ready
from test_team_routes import _login, _user
from test_team_workflows import workflow_world


def create_parent(client, payload):
    return client.post('/api/v1/teams', json={
        key: value for key, value in payload.items() if key not in {'projectId', 'workflowSteps'}
    }).json()['team']


def test_team_workflow_choices_scope_candidates_and_project_names(monkeypatch):
    with workflow_world(monkeypatch) as (app, client, _, there, project, payload):
        team = create_parent(client, {**payload, "memberAgentIds": [payload["leadAgentId"]]})
        path = f"/api/v1/teams/{team['id']}"
        store = app.state.project_store
        other = store.create_project(team["ownerUserId"], {
            "name": "Other computer", "computerId": there["id"], "members": [],
        })
        other_workflow = app.state.context.workflow_store.save_workflow(team["ownerUserId"], {
            "name": "Other computer", "projectId": other["id"], "workflowSteps": payload["workflowSteps"],
        })
        for name, changes in (
            ("Ready", {}),
            ("Disabled", {"enabled": False}),
            ("Different roster", {"workflowSteps": [
                {**payload["workflowSteps"][0], "agentId": payload["memberAgentIds"][1]},
            ]}),
        ):
            response = client.post("/api/v1/workflows", json={
                "name": name, "projectId": project["id"], "workflowSteps": payload["workflowSteps"], **changes,
            })
            assert response.status_code == 201, response.text
            if name == "Ready":
                ready = response.json()["workflow"]
        assert client.put(f"{path}/workflows/{ready['id']}/link", json={}).status_code == 200
        choices = f"{path}/workflow-choices"
        response = client.get(choices)
        assert response.status_code == 200, response.text
        assert response.json() == {
            "workflows": [{"id": ready["id"], "name": ready["name"], "projectId": project["id"]}],
            "projects": [{"id": project["id"], "name": project["name"]}],
        }
        assert other_workflow["id"] not in response.text
        headers = {"If-None-Match": response.headers["etag"]}
        assert client.get(choices, headers=headers).status_code == 304
        assert TestClient(app).get(choices, headers=headers).status_code == 401
        with monkeypatch.context() as legacy:
            get_team = app.state.team_store.get_team
            legacy.setattr(app.state.team_store, "get_team", lambda team_id: {
                key: value for key, value in get_team(team_id).items() if key != "computerId"
            })
            assert client.get(choices).json() == {"workflows": [], "projects": response.json()["projects"]}
        store.archive_project(project["id"], expected_version=project["version"])
        archived = client.get(choices, headers=headers)
        assert archived.json() == {"workflows": [], "projects": response.json()["projects"]}
        _user(client, "outside")
        _login(client, "outside")
        assert client.get(choices, headers=headers).status_code == 403


def test_workflow_link_receipt_preserves_order_and_protects_defaults(monkeypatch):
    with workflow_world(monkeypatch) as (app, client, _, _, project, payload):
        team = create_parent(client, payload)
        path = f"/api/v1/teams/{team['id']}"
        definitions = []
        for name in ("Zebra", "alpha"):
            created = client.post("/api/v1/workflows", json={
                "name": name, "projectId": project["id"], "workflowSteps": payload["workflowSteps"],
            })
            assert created.status_code == 201, created.text
            definitions.append(created.json()["workflow"])
        zebra, alpha = definitions
        suffix = "/link?view=preview&format=delta"
        zebra_path = f"{path}/workflows/{zebra['id']}{suffix}"
        alpha_path = f"{path}/workflows/{alpha['id']}{suffix}"
        assert client.put(zebra_path, json={}).status_code == 200
        linked = client.put(alpha_path, json={})
        assert linked.status_code == 200, linked.text
        receipt = linked.json()["teamWorkflowUpdate"]
        assert receipt["teamId"] == team["id"] and receipt["workflowId"] == alpha["id"]
        assert receipt["version"] == receipt["baseVersion"] + 1
        assert receipt["workflowOrder"] == [
            {"id": item["id"], "version": item["version"]} for item in (alpha, zebra)
        ]
        previews = client.get(f"{path}?view=preview").json()["team"]["workflowPreviews"]
        assert receipt["workflow"] == previews[0]
        assert all("instructions" not in step for step in receipt["workflow"]["workflowSteps"])
        assert TestClient(app).delete(alpha_path).status_code == 401
        assert client.put(f"{path}/workflow-defaults/{project['id']}", json={"workflowId": alpha["id"]}).status_code == 200
        assert client.delete(alpha_path).status_code == 409
        assert client.delete(f"{path}/workflow-defaults/{project['id']}").status_code == 200
        unlinked = client.delete(alpha_path).json()["teamWorkflowUpdate"]
        assert unlinked["workflow"] is None
        assert unlinked["workflowOrder"] == [{"id": zebra["id"], "version": zebra["version"]}]
        assert client.get(f"{path}?view=preview").json()["team"]["workflowPreviews"] == previews[1:]


def test_workflow_default_writes_return_only_changed_fields(monkeypatch):
    with workflow_world(monkeypatch) as (app, client, _, _, project, payload):
        parent = create_parent(client, payload)
        path = f"/api/v1/teams/{parent['id']}"
        workflow = client.post(f"{path}/workflows", json={
            "name": "Project delivery", "projectId": project["id"], "workflowSteps": payload["workflowSteps"],
        }).json()["workflow"]
        original = client.get(f"{path}?view=preview").json()["team"]
        query = "?view=preview&format=delta"
        changed = client.patch(path + query, json={"defaultWorkflowId": "preset:lead_led"})
        assert changed.status_code == 200, changed.text
        receipt = changed.json()["teamWorkflowUpdate"]
        assert receipt == {
            "teamId": parent["id"], "baseVersion": original["version"], "version": original["version"] + 1,
            "updatedAt": receipt["updatedAt"], "defaultWorkflowId": "preset:lead_led", "legacyWorkflow": False,
        }
        assert TestClient(app).patch(path + query, json={"defaultWorkflowId": "preset:lead_led"}).status_code == 401
        assert client.patch(path + query, json={"defaultWorkflowId": "preset:deleted"}).status_code >= 400
        mixed = client.patch(path + query, json={"name": "Updated team", "defaultWorkflowId": "preset:lead_led"})
        assert mixed.json()["team"]["name"] == "Updated team"
        project_path = f"{path}/workflow-defaults/{project['id']}{query}"
        assigned = client.put(project_path, json={"workflowId": workflow["id"]}).json()["teamWorkflowUpdate"]
        cleared = client.delete(project_path).json()["teamWorkflowUpdate"]
        assert assigned["projectDefault"] == {"projectId": project["id"], "workflowId": workflow["id"]}
        assert cleared["projectDefault"] == {"projectId": project["id"], "workflowId": None}
        assert cleared["baseVersion"] == assigned["version"]
        after = client.get(f"{path}?view=preview").json()["team"]
        assert after["workflowPreviews"] == original["workflowPreviews"]
        assert after["defaultWorkflowId"] == "preset:lead_led" and after["projectWorkflowDefaults"] == {}


def test_default_receipt_identifies_conversion_of_a_legacy_workflow_team(monkeypatch):
    with workflow_world(monkeypatch) as (_, client, _, _, _, payload):
        created = client.post("/api/v1/teams", json=payload)
        assert created.status_code == 201, created.text
        team = created.json()["team"]
        path = f"/api/v1/teams/{team['id']}?view=preview"
        before = client.get(path).json()["team"]
        assert before["workflowStepCount"] > 0 and before["projectId"]
        changed = client.patch(f"{path}&format=delta", json={"defaultWorkflowId": "preset:lead_led"})
        assert changed.status_code == 200, changed.text
        receipt = changed.json()["teamWorkflowUpdate"]
        assert receipt["legacyWorkflow"] is False
        assert receipt["baseVersion"] == before["version"]
        after = client.get(path).json()["team"]
        assert "workflowStepCount" not in after and "projectId" not in after
        assert after["defaultWorkflowId"] == receipt["defaultWorkflowId"]
        assert after["workflowPreviews"] == before["workflowPreviews"]


def test_compact_team_summary_shares_members_and_presets(monkeypatch):
    with workflow_world(monkeypatch) as (app, client, _, _, _, payload):
        parent = create_parent(client, payload)
        other = create_parent(client, {**payload, "name": "Same roster"})
        created = client.post("/api/v1/workflows", json={
            "ownerTeamId": parent["id"], "name": "Delivery", "workflowSteps": payload["workflowSteps"],
        })
        assert created.status_code == 201, created.text
        workflow_id = created.json()["workflow"]["id"]
        assert client.patch(f"/api/v1/teams/{parent['id']}", json={"defaultWorkflowId": workflow_id}).status_code == 200
        compact_path = "/api/v1/teams?view=summary&format=compact"
        response = client.get(compact_path)
        assert response.status_code == 200
        packed = response.json()
        assert packed["view"] == "summary"
        assert {team["id"] for team in packed["teams"]} == {parent["id"], other["id"]}
        member_directory = {member["id"]: member for member in packed["memberDirectory"]}
        assert len(packed["memberDirectory"]) == len(member_directory) == len(payload["memberAgentIds"])
        assert len(packed["predefinedWorkflows"]) == 2
        for team in packed["teams"]:
            assert "members" not in team and "lead" not in team
            assert all(option["kind"] == "steps" and "workflowSteps" not in option for option in team["workflowOptions"])
        expanded = [{
            **team,
            "members": [member_directory[member_id] for member_id in team["memberAgentIds"]],
            "lead": member_directory.get(team["leadAgentId"]),
            "workflowOptions": packed["predefinedWorkflows"] + team["workflowOptions"],
        } for team in packed["teams"]]
        legacy = client.get("/api/v1/teams?view=summary")
        assert expanded == legacy.json()["teams"]
        assert len(response.content) < len(legacy.content)
        assert client.get(compact_path, headers={"If-None-Match": response.headers["etag"]}).status_code == 304
        assert TestClient(app).get(compact_path, headers={"If-None-Match": response.headers["etag"]}).status_code == 401


def test_team_roster_summary_preserves_workflow_selection_without_contract_text(monkeypatch):
    with workflow_world(monkeypatch) as (app, client, _, _, project, payload):
        parent = create_parent(client, payload)
        path = f"/api/v1/teams/{parent['id']}"
        agent_id = payload['memberAgentIds'][1]
        assert client.patch(path, json={
            'acceptanceCriteria': ['Private acceptance criterion'],
            'memberConfigs': {agent_id: {'participation': 'on_request', 'responsibility': 'Private responsibility'}},
        }).status_code == 200
        created = client.post(f'{path}/workflows', json={
            'name': 'Feature delivery', 'projectId': project['id'], 'workflowSteps': payload['workflowSteps'],
        })
        assert created.status_code == 201, created.text
        workflow_id = created.json()['workflow']['id']
        assert client.patch(path, json={'defaultWorkflowId': workflow_id}).status_code == 200

        roster = client.get('/api/v1/teams?view=summary')
        assert roster.status_code == 200
        assert roster.json()['view'] == 'summary'
        summary, = roster.json()['teams']
        assert summary['id'] == parent['id'] and summary['defaultWorkflowId'] == workflow_id
        assert summary['memberConfigs'][agent_id]['participation'] == 'on_request'
        assert 'responsibility' not in summary['memberConfigs'][agent_id]
        assert 'acceptanceCriteria' not in summary and 'workflows' not in summary
        workflow = next(option for option in summary['workflowOptions'] if option['id'] == workflow_id)
        assert workflow['projectId'] == project['id']
        assert workflow['stepAgentIds'] == [payload['leadAgentId']]
        assert workflow['stepCount'] == 2 and 'workflowSteps' not in workflow
        assert client.get('/api/v1/teams?view=summary', headers={'If-None-Match': roster.headers['etag']}).status_code == 304

        detail = client.get(path)
        assert detail.status_code == 200 and detail.headers['cache-control'] == 'no-store'
        record = detail.json()['team']
        assert record['acceptanceCriteria'] == ['Private acceptance criterion']
        assert record['memberConfigs'][agent_id]['responsibility'] == 'Private responsibility'
        assert record['workflows'][0]['workflowSteps'][0]['instructions'] == 'Design it'
        legacy, = client.get('/api/v1/teams').json()['teams']
        assert legacy['workflows'] == record['workflows']
        assert 'workflowSteps' in legacy['workflowOptions'][-1]
        assert 'workflowSteps' not in record['workflowOptions'][-1]
        assert client.get(path, headers={'If-None-Match': detail.headers['etag']}).status_code == 304
        preview = client.get(f'{path}?view=preview').json()['team']
        assert all('placements' not in member for member in record['members'] + summary['members'])
        for member in preview['members']:
            assert member['placements']
            for placement in member['placements']:
                assert placement['computerId'] == parent['computerId']
                assert 'workspacePolicy' not in placement and 'conditions' not in placement
        assert preview['memberConfigs'] == record['memberConfigs']
        assert preview['acceptanceCriteria'] == record['acceptanceCriteria']
        assert 'workflows' not in preview and 'workflowSteps' not in preview
        definition, = preview['workflowPreviews']
        assert definition['id'] == workflow_id and definition['teamId'] == parent['id']
        assert [step['id'] for step in definition['workflowSteps']] == ['design', 'deploy']
        assert all('instructions' not in step and 'acceptanceCriteria' not in step for step in definition['workflowSteps'])
        assert client.get('/api/v1/teams/invalid-id').status_code == 404
        assert TestClient(app).get(path).status_code == 401
        _user(client, 'alice')
        _login(client, 'alice')
        assert client.get(path, headers={'If-None-Match': detail.headers['etag']}).status_code == 403


def test_assignable_workflow_choices_exclude_team_owned_definitions_and_step_text(monkeypatch):
    with workflow_world(monkeypatch) as (_, client, _, _, project, payload):
        team = create_parent(client, payload)
        path = '/api/v1/workflows'
        for name, scope in (
            ('Private Team workflow', {'ownerTeamId': team['id']}),
            ('Project workflow', {'projectId': project['id']}),
        ):
            response = client.post(path, json={'name': name, 'workflowSteps': payload['workflowSteps'], **scope})
            assert response.status_code == 201, response.text
        choices = client.get(f'{path}?view=choices')
        assert choices.status_code == 200
        choice, = choices.json()['workflows']
        assert choice == {
            'id': response.json()['workflow']['id'], 'name': 'Project workflow',
            'projectId': project['id'], 'enabled': True, 'stepAgentIds': [payload['leadAgentId']],
        }
        assert client.get(f'{path}?view=choices&projectId={project["id"]}').json()['workflows'] == [choice]
        assert client.get(f'{path}?view=choices', headers={'If-None-Match': choices.headers['etag']}).status_code == 304
        legacy = client.get(path).json()['workflows']
        assert len(legacy) == 2 and all(item['workflowSteps'][0]['instructions'] == 'Design it' for item in legacy)


def test_project_workflow_previews_revalidate_without_step_contracts(monkeypatch):
    with workflow_world(monkeypatch) as (_, client, _, _, project, payload):
        created = client.post('/api/v1/workflows', json={
            'name': 'Feature delivery', 'projectId': project['id'], 'workflowSteps': payload['workflowSteps'],
        })
        assert created.status_code == 201, created.text
        workflow = created.json()['workflow']
        record_path = f"/api/v1/workflows/{workflow['id']}"
        list_path = f"/api/v1/workflows?view=preview&projectId={project['id']}"
        response = client.get(list_path)
        assert response.status_code == 200 and response.headers['cache-control'] == 'no-store'
        preview, = response.json()['workflows']
        assert response.json()['view'] == 'preview'
        assert preview['updatedAt'] == workflow['updatedAt']
        assert preview['workflowSteps'] == [
            {key: step[key] for key in ('id', 'name', 'agentId', 'requiresApproval')}
            for step in workflow['workflowSteps']
        ]
        unchanged = client.get(list_path, headers={'If-None-Match': response.headers['etag']})
        assert unchanged.status_code == 304 and not unchanged.content
        record = client.get(record_path)
        assert record.json()['workflow'] == workflow
        assert client.get(record_path, headers={'If-None-Match': record.headers['etag']}).status_code == 304
        label = client.get(f'{record_path}?view=name')
        assert label.json()['workflow'] == {'id': workflow['id'], 'name': workflow['name']}
        assert client.get(f'{record_path}?view=name', headers={'If-None-Match': label.headers['etag']}).status_code == 304
        changed = client.patch(record_path, json={'name': 'Feature delivery v2'})
        assert changed.status_code == 200, changed.text
        refreshed = client.get(list_path, headers={'If-None-Match': response.headers['etag']})
        assert refreshed.status_code == 200
        assert refreshed.json()['workflows'][0]['name'] == 'Feature delivery v2'


def test_workflow_step_updates_preserve_contracts_and_reject_stale_revisions(monkeypatch):
    with workflow_world(monkeypatch) as (_, client, _, _, project, payload):
        steps = payload['workflowSteps']
        created = client.post('/api/v1/workflows', json={
            'name': 'Step changes', 'projectId': project['id'], 'workflowSteps': steps,
        })
        assert created.status_code == 201, created.text
        base = created.json()['workflow']
        path = f"/api/v1/workflows/{base['id']}"
        compact_path = path + '?view=update'
        first_id, second_id = (step['id'] for step in steps)
        update = {'expectedVersion': base['version'], 'workflowStepChanges': {'byId': {first_id: {'name': 'Review the design'}}}}
        saved = client.patch(compact_path, json=update)
        assert saved.status_code == 200, saved.text
        receipt = saved.json()['workflowUpdate']
        assert receipt['baseVersion'] == base['version'] and receipt['version'] == base['version'] + 1
        assert receipt['workflowStepChanges'] == update['workflowStepChanges']
        current = client.get(path).json()['workflow']
        assert current['workflowSteps'] == [{**base['workflowSteps'][0], 'name': 'Review the design'}, base['workflowSteps'][1]]
        assert client.patch(compact_path, json=update).status_code == 409
        for invalid in (
            {'byId': {first_id: {'id': second_id}}},
            {'byId': {'missing': {'name': 'Unknown'}}},
            {'byId': {first_id: {'name': None}}},
            {'order': [first_id, first_id]},
            {'order': []},
        ):
            assert client.patch(compact_path, json={'expectedVersion': current['version'], 'workflowStepChanges': invalid}).status_code == 400
        assert client.get(path).json()['workflow'] == current
        fields = {'agentId': steps[0]['agentId'], 'name': 'Publish', 'instructions': 'Publish the release',
                  'acceptanceCriteria': ['Verify the release'], 'requiresApproval': False}
        reordered = client.patch(compact_path, json={
            'expectedVersion': current['version'],
            'workflowStepChanges': {'order': [second_id, 'publish'], 'byId': {'publish': fields}},
        })
        assert reordered.status_code == 200, reordered.text
        assert reordered.json()['workflowUpdate']['workflowStepChanges'] == {
            'order': [second_id, 'publish'], 'byId': {'publish': fields},
        }
        assert client.get(path).json()['workflow']['workflowSteps'] == [base['workflowSteps'][1], {'id': 'publish', **fields}]


def test_multiple_workflows_leave_roster_and_policy_unchanged(monkeypatch):
    with workflow_world(monkeypatch) as (app, client, _, _, project, payload):
        parent = create_parent(client, payload)
        path = f"/api/v1/teams/{parent['id']}/workflows"
        definitions = []
        for name in ('Build feature', 'Fix bug'):
            response = client.post(path, json={
                'name': name, 'projectId': project['id'], 'workflowSteps': payload['workflowSteps'],
            })
            assert response.status_code == 201, response.text
            definitions.append(response.json()['workflow'])
        assert definitions[0]['id'] != definitions[1]['id']
        assert all(item['teamId'] == parent['id'] for item in definitions)
        current = app.state.team_store.get_team(parent['id'])
        for key in ('memberAgentIds', 'leadAgentId', 'collaborationStyle'):
            assert current.get(key) == parent.get(key)
        assert 'workflowSteps' not in current
        assert client.get(path).json()['workflows'] == definitions
        changed = client.patch(path + '/' + definitions[0]['id'], json={'name': 'Feature delivery'})
        assert changed.status_code == 200, changed.text
        assert client.get(path).json()['workflows'][1] == definitions[1]
        assert client.delete(path + '/' + definitions[0]['id']).status_code == 200
        assert client.get(path).json()['workflows'] == [definitions[1]]
        assert app.state.team_store.get_team(parent['id'])['enabled']


def test_team_owned_workflow_step_edit_keeps_the_team_revision(monkeypatch):
    with workflow_world(monkeypatch) as (app, client, _, _, _, payload):
        parent = create_parent(client, payload)
        base = client.post('/api/v1/workflows', json={
            'name': 'Team workflow', 'ownerTeamId': parent['id'], 'workflowSteps': payload['workflowSteps'],
        }).json()['workflow']
        team_path = f"/api/v1/teams/{parent['id']}?view=preview"
        before = client.get(team_path).json()['team']
        link_events = app.state.team_store.events(parent['id'])
        step_id = base['workflowSteps'][0]['id']
        response = client.patch(f"/api/v1/workflows/{base['id']}?view=update", json={
            'expectedVersion': base['version'], 'workflowStepChanges': {'byId': {step_id: {'name': 'New step name'}}},
        })
        assert response.status_code == 200, response.text
        receipt = response.json()['workflowUpdate']
        assert receipt['teamLinkUnchanged'] is True
        after = client.get(team_path).json()['team']
        assert after['version'] == before['version']
        assert app.state.team_store.events(parent['id']) == link_events
        preview, = after['workflowPreviews']
        assert preview['version'] == receipt['version']
        assert preview['workflowSteps'][0]['name'] == 'New step name'
        option = next(item for item in after['workflowOptions'] if item['id'] == base['id'])
        assert option['version'] == receipt['version']


def test_invalid_definition_and_service_actor_cannot_write(monkeypatch):
    with workflow_world(monkeypatch) as (app, client, _, _, project, payload):
        parent = create_parent(client, payload)
        path = f"/api/v1/teams/{parent['id']}/workflows"
        body = {'name': 'Build', 'projectId': project['id'], 'workflowSteps': payload['workflowSteps']}
        before = app.state.team_store.events(parent['id'])
        for patch in ({'teamId': 'other'}, {'workflowSteps': []}, {'enabled': 'yes'},
                      {'workflowSteps': [{**payload['workflowSteps'][0], 'agentId': 'outsider'}]}):
            response = client.post(path, json={**body, **patch})
            assert response.status_code == 400, response.text
        service = TestClient(app)
        service.headers.update({'Authorization': 'Bearer chat-test', 'x-relay-user-id': parent['ownerUserId']})
        assert service.post(path, json=body).status_code == 403
        assert app.state.team_store.events(parent['id']) == before


def test_runs_freeze_selected_workflow_and_are_idempotent_per_definition(monkeypatch):
    from uuid import uuid4
    with workflow_world(monkeypatch) as (app, client, here, _, project, payload):
        parent = create_parent(client, payload)
        path = f"/api/v1/teams/{parent['id']}/workflows"
        steps = [{**payload['workflowSteps'][0], 'requiresApproval': True}]
        workflows = [client.post(path, json={
            'name': name, 'projectId': project['id'], 'workflowSteps': steps,
        }).json()['workflow'] for name in ('Build', 'Fix')]
        body = {'requestId': str(uuid4()), 'taskGoal': 'Do work'}
        runs = []
        for workflow in workflows:
            run_path = path + '/' + workflow['id'] + '/runs'
            response = client.post(run_path, json=body)
            assert response.status_code == 201, response.text
            run = response.json()
            runs.append(run)
            snapshot = run['workflowRuns'][0]['teamSnapshot']
            assert run['teamId'] == parent['id']
            assert snapshot['workflowId'] == workflow['id']
            assert snapshot['name'] == workflow['name']
            assert client.post(run_path, json=body).json()['id'] == run['id']
            assert client.patch(path + '/' + workflow['id'], json={'name': workflow['name'] + ' updated'}).status_code == 200
            assert app.state.session_store.get_session(run['id'])['workflowRuns'][0]['teamSnapshot'] == snapshot
        assert runs[0]['id'] != runs[1]['id']
        assert app.state.registry.take_commands(here['id'], 'token_node_here') == []


def test_task_selects_a_project_workflow_without_a_team(monkeypatch):
    with workflow_world(monkeypatch) as (app, client, _, _, project, payload):
        workflow = client.post('/api/v1/workflows', json={
            'name': 'Feature', 'projectId': project['id'],
            'workflowSteps': [{**payload['workflowSteps'][0], 'requiresApproval': True}],
        }).json()['workflow']
        response = client.post('/api/v1/tasks', json={
            'title': 'Feature task', 'projectId': project['id'],
            'assignedWorkflowId': workflow['id'],
        })
        assert response.status_code == 201, response.text
        task = response.json()
        assert task['assignedWorkflowId'] == workflow['id']
        assert not task.get('assignedTeamId')
        response = client.post(f"/api/v1/tasks/{task['id']}/runs", json={})
        assert response.status_code == 202, response.text
        session = response.json()['session']
        assert session['workflowRuns'][0]['teamSnapshot']['workflowId'] == workflow['id']
        assert not session.get('teamId')


def test_task_workflow_can_be_changed_cleared_and_rejects_foreign_scope(monkeypatch):
    with workflow_world(monkeypatch) as (app, client, _, _, project, payload):
        workflows = [client.post('/api/v1/workflows', json={
            'name': name, 'projectId': project['id'], 'workflowSteps': payload['workflowSteps'],
        }).json()['workflow'] for name in ('Build', 'Fix')]
        task = client.post('/api/v1/tasks', json={
            'title': 'Choose process', 'projectId': project['id'],
            'assignedWorkflowId': workflows[0]['id'],
        }).json()
        for workflow in workflows:
            response = client.patch(f"/api/v1/tasks/{task['id']}", json={'assignedWorkflowId': workflow['id']})
            assert response.status_code == 200, response.text
            assert response.json()['assignedWorkflowId'] == workflow['id']
        response = client.patch(f"/api/v1/tasks/{task['id']}", json={'assignedWorkflowId': None})
        assert response.status_code == 200, response.text
        assert not response.json().get('assignedWorkflowId')
        # A Project Task still names only its own Project's Workflow.
        from issue_projects import project_for_agents
        other = project_for_agents(app.state.project_store, project['ownerUserId'],
                                   [app.state.agent_store.get_agent(project['leadAgentId'])], name='Other project')
        foreign = client.post('/api/v1/workflows', json={
            'name': 'Foreign', 'projectId': other['id'], 'workflowSteps': payload['workflowSteps'],
        }).json()['workflow']
        response = client.post('/api/v1/tasks', json={
            'title': 'Wrong scope', 'projectId': project['id'],
            'assignedWorkflowId': foreign['id'],
        })
        assert response.status_code == 409, response.text
        assert 'team_workflow_project_mismatch' in response.text


def test_disabled_definitions_can_be_edited_and_enabled_again(monkeypatch):
    from uuid import uuid4
    with workflow_world(monkeypatch) as (_, client, _, _, project, payload):
        parent = create_parent(client, payload)
        path = f"/api/v1/teams/{parent['id']}/workflows"
        response = client.post(path, json={
            'name': 'Draft', 'projectId': project['id'], 'workflowSteps': payload['workflowSteps'], 'enabled': False,
        })
        assert response.status_code == 201, response.text
        path += '/' + response.json()['workflow']['id']
        assert client.post(path + '/runs', json={'requestId': str(uuid4()), 'taskGoal': 'Work'}).status_code == 409
        assert client.patch(path, json={'name': 'Ready', 'enabled': True}).status_code == 200
        assert client.patch(path, json={'enabled': False}).status_code == 200


@pytest.mark.parametrize("team_change", [None, "disabled", "deleted", "removed_member"])
def test_frozen_run_survives_definition_deletion_but_requires_live_team(monkeypatch, team_change):
    from uuid import uuid4
    with workflow_world(monkeypatch) as (app, client, here, _, project, payload):
        parent = create_parent(client, payload)
        path = f"/api/v1/teams/{parent['id']}/workflows"
        workflow = client.post(path, json={
            'name': 'Build', 'projectId': project['id'],
            'workflowSteps': [{**payload['workflowSteps'][0], 'requiresApproval': True}],
        }).json()['workflow']
        run = client.post(path + '/' + workflow['id'] + '/runs', json={
            'requestId': str(uuid4()), 'taskGoal': 'Build it',
        }).json()
        assert client.delete(path + '/' + workflow['id']).status_code == 200
        if team_change == 'disabled':
            app.state.team_store.update_team(parent['id'], {'enabled': False})
        elif team_change == 'deleted':
            app.state.team_store.delete_team(parent['id'])
        elif team_change == 'removed_member':
            app.state.team_store.remove_member(parent['id'], payload['leadAgentId'])
        first = run['workflowRuns'][0]['assignments'][0]
        decision = {key: first[key] for key in ('workflowRunId', 'workflowStepId', 'workflowAttempt', 'assignmentId')}
        response = client.post(f"/api/v1/threads/{run['id']}/workflow-decisions", json={
            **decision, 'kind': 'approve', 'expectedRevision': 0,
        })
        assert response.status_code == (409 if team_change else 200), response.text
        assert len(app.state.registry.take_commands(here['id'], 'token_node_here')) == (0 if team_change else 1)


@pytest.mark.parametrize('entry', ['task', 'automation'])
def test_scheduler_preserves_selected_workflow(monkeypatch, entry):
    from datetime import UTC, datetime, timedelta
    from automation_helpers import DAILY_TRIGGERS
    from test_scheduled_workflows import tick, workflow_session, occurrence_of
    with workflow_world(monkeypatch) as (app, client, here, _, project, payload):
        workflow = client.post('/api/v1/workflows', json={
            'name': 'Scheduled build', 'projectId': project['id'],
            'workflowSteps': [{**payload['workflowSteps'][0], 'requiresApproval': True}],
        }).json()['workflow']
        task = client.post('/api/v1/tasks', json={
            'title': 'Scheduled work', 'projectId': project['id'],
            'assignedWorkflowId': workflow['id'],
            **({'isRoutine': True, 'routineState': 'active', 'routineTriggers': DAILY_TRIGGERS}
               if entry == 'automation' else {}),
        }).json()
        if entry == 'automation':
            app.state.task_scheduler.automations.tick(datetime.now(UTC) + timedelta(days=2))
            task = occurrence_of(app, task['id'])
        else:
            mark_task_ready(client, task)
        tick(app)
        current, session = workflow_session(app, task['id'])
        assert current['assignedWorkflowId'] == workflow['id']
        assert current['status'] == 'waiting_for_human'
        assert session['workflowRuns'][0]['teamSnapshot']['workflowId'] == workflow['id']
        assert app.state.registry.take_commands(here['id'], 'token_node_here') == []
