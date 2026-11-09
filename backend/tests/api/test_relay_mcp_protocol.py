"""The backend owns the MCP protocol, catalog, authorization and dispatch."""

from concurrent.futures import ThreadPoolExecutor
from fastapi.testclient import TestClient
import test_project_setup_api as setup_api
from test_relay_mcp_api import _token

setup_env = setup_api.setup_env
ENDPOINT = "/api/v1/mcp"


def _headers(token):
    return {
        "Authorization": f"Bearer {token}",
        "Accept": "application/json, text/event-stream",
        "Content-Type": "application/json",
        "MCP-Protocol-Version": "2025-11-25",
    }


def _rpc(client, token, method, params=None, request_id=1):
    return client.post(
        ENDPOINT,
        headers=_headers(token),
        json={
            "jsonrpc": "2.0",
            "id": request_id,
            "method": method,
            **({"params": params} if params is not None else {}),
        },
    )


def test_mcp_protocol_is_hosted_and_requires_a_bearer_even_with_a_cookie(setup_env):
    app, owner, _, project, *_ = setup_env
    grant = _token(owner, project)
    with TestClient(app) as client:
        assert client.post(ENDPOINT, json={"jsonrpc": "2.0", "id": 1, "method": "initialize"}).status_code == 401
        client.cookies.update(owner.cookies)
        assert client.post(ENDPOINT, json={"jsonrpc": "2.0", "id": 1, "method": "initialize"}).status_code == 401
        response = _rpc(
            client,
            grant["token"],
            "initialize",
            {
                "protocolVersion": "2025-11-25",
                "capabilities": {},
                "clientInfo": {"name": "local-test", "version": "1"},
            },
        )
        assert response.status_code == 200, response.text
        assert response.json()["result"]["serverInfo"]["name"] == "relay-projects"
        listed = _rpc(client, grant["token"], "tools/list")
        assert listed.status_code == 200, listed.text
        assert listed.headers["cache-control"] == "no-store"
        tools = listed.json()["result"]["tools"]
        assert {"relay_project_overview", "relay_create_task", "relay_list_automations", "relay_update_automation"} <= {t["name"] for t in tools}
        assert "relay_propose_task_changes" not in {t["name"] for t in tools}
        assert all("apply" not in t["name"] for t in tools)
        notify = client.post(
            ENDPOINT,
            headers=_headers(grant["token"]),
            json={
                "jsonrpc": "2.0",
                "method": "notifications/initialized",
            },
        )
        assert notify.status_code == 202, notify.text
        for method in ("GET", "DELETE", "HEAD"):
            assert client.request(method, ENDPOINT).status_code == 401
            unsupported = client.request(method, ENDPOINT, headers=_headers(grant["token"]))
            assert unsupported.status_code == 405
            assert unsupported.headers["allow"] == "POST"


def test_python_mcp_dispatch_validates_scope_arguments_and_revocation(setup_env):
    app, owner, node, project, *_ = setup_env
    grant = _token(owner, project)
    other = owner.post(
        "/api/v1/projects", json={"name": "Other Project", "daemonNodeId": node["id"], "members": []}
    ).json()["project"]
    with TestClient(app) as client:
        result = _rpc(
            client,
            grant["token"],
            "tools/call",
            {"name": "relay_project_overview", "arguments": {"projectId": project["id"]}},
        )
        assert result.status_code == 200, result.text
        assert result.json()["result"]["structuredContent"]["project"]["id"] == project["id"]
        for name, args in [
            ("relay_project_overview", {"projectId": other["id"]}),
            ("relay_project_overview", {"projectId": project["id"], "unexpected": True}),
            ("relay_get_task", {"projectId": project["id"]}),
            ("relay_apply", {"projectId": project["id"]}),
        ]:
            denied = _rpc(client, grant["token"], "tools/call", {"name": name, "arguments": args})
            assert denied.status_code == 200, denied.text
            assert denied.json()["result"]["isError"] is True
        assert grant["token"] not in str(result.json())
        owner.delete(f"/api/v1/mcp/tokens/{grant['id']}")
        assert _rpc(client, grant["token"], "tools/list").status_code == 401


def test_concurrent_mcp_requests_keep_their_own_grants(setup_env):
    app, owner, node, project, *_ = setup_env
    other = owner.post(
        "/api/v1/projects", json={"name": "Concurrent Project", "daemonNodeId": node["id"], "members": []}
    ).json()["project"]
    grants = [_token(owner, p) for p in [project, other]]
    with TestClient(app) as client:

        def read(index):
            value = _rpc(
                client,
                grants[index % 2]["token"],
                "tools/call",
                {"name": "relay_list_projects", "arguments": {}},
                request_id=index,
            )
            assert value.status_code == 200, value.text
            return [p["id"] for p in value.json()["result"]["structuredContent"]["projects"]]

        with ThreadPoolExecutor(max_workers=4) as pool:
            results = list(pool.map(read, range(12)))
        assert results == [[(project if i % 2 == 0 else other)["id"]] for i in range(12)]


def test_mcp_transport_bounds_requests_and_rejects_untrusted_browser_origins(setup_env):
    app, owner, _, project, *_ = setup_env
    token = _token(owner, project)["token"]
    with TestClient(app) as client:
        large = client.post(ENDPOINT, headers=_headers(token), content=b"x" * (128 * 1024 + 1))
        assert large.status_code == 413
        origin = client.post(
            ENDPOINT,
            headers={**_headers(token), "Origin": "https://untrusted.example"},
            json={
                "jsonrpc": "2.0",
                "id": 1,
                "method": "tools/list",
            },
        )
        assert origin.status_code == 403


def test_mcp_errors_hide_internal_failures_and_bound_the_actual_wire_result(setup_env, monkeypatch):
    import relay.mcp.server as server

    app, owner, _, project, *_ = setup_env
    token = _token(owner, project)["token"]
    with TestClient(app) as client:
        monkeypatch.setattr(server, "invoke", lambda *_args: {"large": "x" * 600_000})
        oversized = _rpc(
            client, token, "tools/call", {"name": "relay_project_overview", "arguments": {"projectId": project["id"]}}
        )
        assert oversized.json()["result"]["isError"] is True
        assert "narrow" in oversized.json()["result"]["content"][0]["text"]

        def fail(*_args):
            raise RuntimeError("private-database-credential")

        monkeypatch.setattr(server, "invoke", fail)
        failed = _rpc(
            client, token, "tools/call", {"name": "relay_project_overview", "arguments": {"projectId": project["id"]}}
        )
        assert failed.json()["result"]["isError"] is True
        assert "private-database-credential" not in failed.text
