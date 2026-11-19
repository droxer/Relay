"""Public connection routes authenticate, scope grants, and keep secrets private."""

import json
from urllib.parse import parse_qs, urlsplit

import httpx
import pytest
from cryptography.fernet import Fernet

from relay.connections import mail_oauth, providers
from relay.core.connections import ConnectionConfig, PROVIDERS
from relay.core.ids import new_database_id
from relay.automations.service import automation_service
from datetime import datetime, UTC
from test_github_issue_import import ALICE
from test_github_issue_import import context as context


@pytest.fixture(autouse=True)
def configuration(monkeypatch):
    monkeypatch.setenv("RELAY_CONNECTIONS_ENCRYPTION_KEY", Fernet.generate_key().decode())
    monkeypatch.setenv("RELAY_CONNECTIONS_GITHUB_CLIENT_ID", "client")
    monkeypatch.setenv("RELAY_CONNECTIONS_GITHUB_CLIENT_SECRET", "client-secret")
    monkeypatch.setenv("RELAY_CONNECTIONS_GITHUB_CALLBACK_URL", "https://relay.example/api/v1/connections/callback/github")

    def handler(request):
        if request.url.path.endswith("access_token"):
            return httpx.Response(200, json={"access_token": "secret-token", "scope": "read:user,repo"})
        if request.url.path == "/user":
            return httpx.Response(200, json={"id": 17, "login": "octocat"})
        if request.url.path == "/user/repos":
            return httpx.Response(200, json=[{"id": 42, "full_name": "octo/hello"}])
        if request.url.path == "/repos/octo/hello/issues":
            return httpx.Response(200, json=[{"number": 1, "title": "Connections"}])
        raise AssertionError(str(request.url))

    monkeypatch.setattr(providers, "transport", httpx.MockTransport(handler))


def _connect(client):
    response = client.post("/api/v1/connections/authorizations", json={"provider": "github", "returnTo": "/settings/connections"})
    assert response.status_code == 200, response.text
    state = parse_qs(urlsplit(response.json()["url"]).query)["state"][0]
    callback = client.get("/api/v1/connections/callback/github", params={"state": state, "code": "code"}, follow_redirects=False)
    assert callback.status_code == 303, callback.text
    assert callback.headers["location"] == "/settings/connections"
    return client.get("/api/v1/connections").json()["connections"][0]


def test_connect_resources_grants_and_disconnect(context):
    _app, client, _project = context
    connection = _connect(client)
    assert "secret-token" not in str(connection)
    resources = client.get(f"/api/v1/connections/{connection['id']}/resources")
    assert resources.json()["resources"][0]["id"] == "octo/hello"
    task = client.post("/api/v1/tasks", json={"title": "Read issues"}).json()
    path = f"/api/v1/connection-grants/task/{task['id']}"
    grant = {"connectionId": connection["id"], "resources": ["octo/hello"], "actions": ["github.list_issues"]}
    saved = client.put(path, json={"grants": [grant]})
    assert saved.status_code == 200, saved.text
    assert client.get(path).json()["grants"][0]["connectionId"] == connection["id"]
    assert client.get(f"/api/v1/connections/{connection['id']}/usage").json()["usage"][0]["targetId"] == task["id"]
    assert client.delete(f"/api/v1/connections/{connection['id']}").status_code == 200
    assert client.get("/api/v1/connections").json()["connections"] == []


def test_routes_require_session(context):
    _app, client, _project = context
    client.cookies.clear()
    for path in ("connection-providers", "connections", "connections/x/resources", "connection-grants/task/x"):
        assert client.get(f"/api/v1/{path}").status_code == 401
    assert client.post("/api/v1/connections/authorizations", json={"provider": "github"}).status_code == 401


def test_grants_require_real_owned_targets(context):
    _app, client, _project = context
    assert client.put("/api/v1/connection-grants/task/missing", json={"grants": []}).status_code == 404
    assert client.put("/api/v1/connection-grants/computer/missing", json={"grants": []}).status_code == 400


def test_catalog_distinguishes_configured_and_unconfigured_providers(context):
    _app, client, _project = context
    response = client.get("/api/v1/connection-providers")
    assert response.status_code == 200
    assert {p["id"]: p["configured"] for p in response.json()["providers"]} == {
        "github": True, "gmail": False, "outlook": False}


@pytest.mark.parametrize("provider", ["gmail", "outlook"])
def test_mail_callback_and_run_broker(context, monkeypatch, provider):
    app, client, project = context
    callback_path = f"/api/v1/connections/callback/{provider}"
    app.state.connections.configs[provider] = ConnectionConfig(provider, "client", "secret", "https://relay.example" + callback_path)
    monkeypatch.setattr(mail_oauth, "verify_identity", lambda *_:
        {"subject": "mailbox-1", "identity": "mail@example.com", "tenant": "tenant-1"})

    def reply(request):
        if request.method == "POST":
            return httpx.Response(200, json={"access_token": "private-access", "refresh_token": "private-refresh",
                "expires_in": 3600, "scope": PROVIDERS[provider].required_scope})
        path = request.url.path
        if path.endswith("/mailFolders/inbox"):
            return httpx.Response(200, json={"id": "inbox-folder"})
        if provider == "outlook" and path.endswith(("/messages", "/messages/msg1")):
            item = {"id": "msg1", "parentFolderId": "inbox-folder", "subject": "Meeting",
                "receivedDateTime": "2026-11-19T00:00:00Z", "isRead": False,
                "body": {"contentType": "text", "content": "Private agenda"}}
            return httpx.Response(200, json={"value": [item]} if path.endswith("/messages") else item)
        if path.endswith("/messages"):
            return httpx.Response(200, json={"messages": [{"id": "msg1"}]})
        if path.endswith("/messages/msg1"):
            return httpx.Response(200, json={"id": "msg1", "labelIds": ["INBOX"], "internalDate": "1710000000000",
                "payload": {"mimeType": "text/plain", "headers": [{"name": "Subject", "value": "Meeting"}],
                    "body": {"data": "UHJpdmF0ZSBhZ2VuZGE"}}})
        raise AssertionError(str(request.url))

    monkeypatch.setattr(providers, "transport", httpx.MockTransport(reply))

    def start_callback(**params):
        start = client.post("/api/v1/connections/authorizations", json={"provider": provider})
        assert start.status_code == 200, start.text
        state = parse_qs(urlsplit(start.json()["url"]).query)["state"][0]
        return client.get(callback_path, params={"state": state, **params}, follow_redirects=False)

    cancelled = start_callback(error="access_denied")
    assert cancelled.headers["location"] == "/settings/connections?connectionResult=cancelled"
    blocked = start_callback(error="admin_policy_enforced", error_description="Provider-only text")
    assert blocked.headers["location"] == "/settings/connections?connectionResult=organization_policy"
    callback = start_callback(code="oauth-code")
    assert callback.status_code == 303, callback.text
    [connection] = client.get("/api/v1/connections").json()["connections"]
    connection_id = connection["id"]
    assert callback.headers["location"] == f"/settings/connections?connectionResult=connected&connectionResultId={connection_id}"
    assert "private-" not in str(connection)

    grant = {"connectionId": connection_id, "resources": ["inbox"], "actions": list(PROVIDERS[provider].actions)}
    node = app.state.registry.monitor_nodes()[0]
    app.state.registry.register({**node, "sandboxId": node["id"], "token": "token_node_alice_github",
        "protocolVersion": 2, "supportedAgents": ["codex", "claude"],
        "capabilities": [*node["capabilities"], "service-connections", "work-results", "task-workspaces"]})
    thread = client.post("/api/v1/agent-runs", json={"taskGoal": "Summarize Inbox", "projectId": project["id"],
        "connectionGrants": [grant]})
    assert thread.status_code == 202, thread.text
    lease = next(row for row in app.state.daemon_store.take_queued_commands(node["id"]) if row["command"].get("connections"))
    credential = client.post(f"/api/v1/daemon-nodes/{node['id']}/commands/{lease['id']}/connections",
        json={"leaseId": lease["leaseId"]}, headers={"Authorization": "Bearer token_node_alice_github"})
    assert credential.status_code == 200, credential.text
    headers = {"Authorization": f"Bearer {credential.json()['token']}"}

    def tool(method, params=None):
        response = client.post("/api/v1/connection-tools", headers=headers,
            json={"jsonrpc": "2.0", "id": 1, "method": method, "params": params})
        assert response.status_code == 200, response.text
        return response.json()["result"]

    def call(action, arguments):
        return tool("tools/call", {"name": "connection_call", "arguments": {
            "connectionId": connection_id, "resource": "inbox", "action": f"{provider}.{action}", "arguments": arguments}})

    assert "receivedAfter" in tool("tools/list")["tools"][0]["description"]
    listed = json.loads(call("list_messages", {})["content"][0]["text"])
    assert "Private agenda" not in str(listed)
    assert listed["messages"][0]["subject"] == "Meeting"
    body = json.loads(call("get_message", {"messageId": listed["messages"][0]["id"]})["content"][0]["text"])
    assert body["body"] == "Private agenda"
    assert client.delete(f"/api/v1/connections/{connection_id}").status_code == 200
    assert call("list_messages", {})["content"][0]["text"] == "connection_unavailable"


def test_automation_occurrence_snapshots_grants_and_cannot_expand_them(context):
    app, client, project = context
    connection = _connect(client)
    routine_response = client.post("/api/v1/tasks", json={"title": "Weekly issues", "projectId": project["id"],
        "isRoutine": True, "routineState": "active", "routineTriggers": []})
    assert routine_response.status_code == 201, routine_response.text
    routine = routine_response.json()
    grant = {"connectionId": connection["id"], "resources": ["octo/hello"], "actions": ["github.list_issues"]}
    path = f"/api/v1/connection-grants/automation/{routine['id']}"
    assert client.put(path, json={"grants": [grant]}).status_code == 200
    occurrence = app.state.task_store.create_triggered_occurrence(routine["id"], run_date="2026-11-06",
        trigger_kind="manual", depth=0, context="Run now")
    assert occurrence
    grants_path = f"/api/v1/connection-grants/task/{occurrence['id']}"
    response = client.get(grants_path)
    assert len(response.json()["grants"]) == 1
    assert response.json()["readOnly"] is True
    assert client.put(grants_path, json={"grants": []}).status_code == 409
    assert client.delete(f"/api/v1/connections/{connection['id']}").status_code == 200
    assert app.state.task_store.get_task(routine["id"])["routinePauseReason"] == "connection_unavailable"


def test_run_bound_tools_check_lease_and_live_revocation(context):
    app, client, _project = context
    connection = _connect(client)
    thread = app.state.session_store.create_session({"workspacePath": "/workspace", "taskGoal": "Read issues", "ownerUserId": ALICE})
    grant = {"connectionId": connection["id"], "resources": ["octo/hello"], "actions": ["github.list_issues"]}
    saved = client.put(f"/api/v1/connection-grants/thread/{thread['id']}", json={"grants": [grant]}).json()["grants"]
    node = app.state.registry.monitor_nodes()[0]
    command_id = new_database_id()
    app.state.daemon_store.enqueue_command(node["id"], {"id": command_id, "type": "run.start",
        "sessionId": thread["id"], "runId": new_database_id(), "agent": "codex", "taskGoal": "Read issues", "connections": saved})
    [lease] = app.state.daemon_store.take_queued_commands(node["id"])
    path = f"/api/v1/daemon-nodes/{node['id']}/commands/{command_id}/connections"
    node_headers = {"Authorization": "Bearer token_node_alice_github"}
    assert client.post(path, json={"leaseId": "wrong"}, headers=node_headers).status_code == 409
    response = client.post(path, json={"leaseId": lease["leaseId"]}, headers=node_headers)
    assert response.status_code == 200, response.text
    assert "secret-token" not in response.text
    headers = {"Authorization": f"Bearer {response.json()['token']}"}
    malformed = client.post("/api/v1/connection-tools", headers=headers, json={"jsonrpc": "2.0", "id": 0, "method": "initialize", "params": "invalid"})
    assert malformed.status_code == 400
    tools = client.post("/api/v1/connection-tools", headers=headers, json={"jsonrpc": "2.0", "id": 1, "method": "tools/list"})
    assert tools.status_code == 200, tools.text
    assert len(tools.json()["result"]["tools"]) == 1
    call = {"jsonrpc": "2.0", "id": 2, "method": "tools/call", "params": {"name": "connection_call", "arguments": {
        "connectionId": connection["id"], "action": "github.list_issues", "resource": "octo/hello", "arguments": {}}}}
    result = client.post("/api/v1/connection-tools", headers=headers, json=call)
    assert "Connections" in result.json()["result"]["content"][0]["text"]
    client.delete(f"/api/v1/connections/{connection['id']}")
    result = client.post("/api/v1/connection-tools", headers=headers, json=call)
    assert result.json()["result"]["isError"] is True
    assert client.post("/api/v1/connection-tools", json=call).status_code == 401


def test_task_creation_saves_access_atomically(context):
    app, client, _project = context
    connection = _connect(client)
    grant = {"connectionId": connection["id"], "resources": ["octo/hello"], "actions": ["github.list_issues"]}
    response = client.post("/api/v1/tasks", json={"title": "Read issues", "connectionGrants": [grant]})
    assert response.status_code == 201, response.text
    task = response.json()
    assert len(client.get(f"/api/v1/connection-grants/task/{task['id']}").json()["grants"]) == 1
    before = len(app.state.task_store.list_tasks())
    response = client.post("/api/v1/tasks", json={"title": "Invalid access", "connectionGrants": [{**grant, "actions": ["arbitrary.http"]}]})
    assert response.status_code == 400, response.text
    assert len(app.state.task_store.list_tasks()) == before


def test_new_thread_saves_access_before_delivery(context):
    app, client, project = context
    connection = _connect(client)
    grant = {"connectionId": connection["id"], "resources": ["octo/hello"], "actions": ["github.list_issues"]}
    node = app.state.registry.monitor_nodes()[0]
    app.state.registry.register({**node, "sandboxId": node["id"], "token": "token_node_alice_github",
        "protocolVersion": 2, "supportedAgents": ["codex", "claude"],
        "capabilities": [*node["capabilities"], "service-connections", "work-results", "task-workspaces"]})
    response = client.post("/api/v1/agent-runs", json={"taskGoal": "Read issues", "projectId": project["id"], "connectionGrants": [grant]})
    assert response.status_code == 202, response.text
    thread = response.json()
    saved = client.get(f"/api/v1/connection-grants/thread/{thread['id']}").json()["grants"]
    assert len(saved) == 1
    commands = app.state.daemon_store.take_queued_commands(node["id"])
    assert any(record["command"].get("connections") for record in commands)


def test_unavailable_service_pauses_before_automation_fires_and_prevents_resume(context):
    app, client, project = context
    connection = _connect(client)
    routine = client.post("/api/v1/tasks", json={"title": "Read issues", "projectId": project["id"],
        "isRoutine": True, "routineState": "active", "routineTriggers": [], "connectionGrants": [{
            "connectionId": connection["id"], "resources": ["octo/hello"], "actions": ["github.list_issues"]}]}).json()
    stored = app.state.connections.store.get(ALICE, connection["id"])
    app.state.connections._unavailable(ALICE, stored)
    app.state.automation_store.enqueue_manual(routine["id"])
    automation_service(app.state.automation_store, app.state.context).tick(datetime.now(UTC))
    current = app.state.task_store.get_task(routine["id"])
    assert current.get("occurrenceIds", []) == []
    assert current["routinePauseReason"] == "connection_unavailable"
    assert client.post(f"/api/v1/tasks/{routine['id']}/automation/resume").status_code == 409


def test_admin_cannot_access_another_users_connections(context):
    _app, client, _project = context
    connection = _connect(client)
    assert client.post("/api/v1/auth/login", json={"username": "admin", "password": "kestrel-vault-7719"}).status_code == 200
    assert client.get("/api/v1/connections").json()["connections"] == []
    assert client.delete(f"/api/v1/connections/{connection['id']}").status_code == 404
    assert client.get(f"/api/v1/connections/{connection['id']}/resources").status_code == 404
