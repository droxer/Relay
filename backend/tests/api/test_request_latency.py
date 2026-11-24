"""Per-request store traffic on the polled routes stays bounded."""

from __future__ import annotations

from tempfile import TemporaryDirectory
from typing import Any

import pytest
from fastapi.testclient import TestClient
from relay.api.admin.dashboard import DASHBOARD_CACHE
from relay.app import create_app
from relay.core.computer_identity import computer_id
from relay.core.ids import new_database_id
from relay.security.auth_cache import SESSION_ACCOUNTS
from user_ids import user_id

ALICE = user_id("alice")
PASSWORD = "kestrel-vault-7719"


def _bootstrap(client: TestClient) -> None:
    response = client.post(
        "/api/v1/auth/bootstrap",
        json={"token": "admin_token", "username": "admin", "email": "admin@example.com", "password": PASSWORD},
    )
    assert response.status_code == 200


def _register_node(
    app: Any, node_id: str, *, user: str = ALICE, workspace_id: str | None = None,
) -> dict[str, Any]:
    return app.state.registry.register(
        {
            "sandboxId": node_id,
            "userId": user,
            "workspaceId": workspace_id or f"machine-{node_id}",
            "token": f"token-{node_id}",
            "workspacePath": f"/workspace/{node_id}",
            "nodeLocation": "user-device",
            "protocolVersion": 1,
            "supportedAgents": ["claude", "codex"],
            "capabilities": ["workspace-scope", "thread-workspaces", "agent-model"],
            "status": "ready",
        }
    )


def _count_calls(monkeypatch: pytest.MonkeyPatch, target: Any, name: str) -> list[int]:
    calls = [0]
    original = getattr(target, name)

    def counting(*args: Any, **kwargs: Any) -> Any:
        calls[0] += 1
        return original(*args, **kwargs)

    monkeypatch.setattr(target, name, counting)
    return calls


@pytest.fixture
def roster(monkeypatch):
    monkeypatch.setenv("RELAY_ADMIN_TOKEN", "admin_token")
    with TemporaryDirectory() as root:
        app = create_app(root)
        client = TestClient(app)
        _bootstrap(client)
        assert client.post(
            "/api/v1/admin/users",
            json={"userId": "alice", "username": "alice", "email": "alice@example.com", "password": "userpass", "displayName": "Alice"},
        ).status_code == 201
        # Existing registrations can store surrounding whitespace. The stable
        # Computer identity strips it before Agents and Placements use it.
        node = _register_node(app, "node_a", workspace_id="\tmachine-node_a\u2003")
        agent_ids = []
        for index in range(3):
            created = client.post(
                "/api/v1/admin/agents",
                json={
                    "supervisorUserId": ALICE,
                    "displayName": f"Agent {index}",
                    "executorKind": "claude" if index % 2 == 0 else "codex",
                    "computerId": computer_id(node),
                    "defaultRole": "implementer",
                },
            )
            assert created.status_code == 201, created.text
            agent_ids.append(created.json()["agent"]["id"])
        team = client.post(
            "/api/v1/admin/teams",
            json={
                "ownerUserId": ALICE,
                "name": "Crew",
                "leadAgentId": agent_ids[0],
                "memberAgentIds": agent_ids,
            },
        )
        assert team.status_code == 201, team.text
        yield app, client, agent_ids


# ── Fix 1: one node read per request on the agent and team lists ─────────


def test_agent_list_reads_the_fleet_once_per_request(roster, monkeypatch) -> None:
    app, client, agent_ids = roster
    baseline = client.get("/api/v1/admin/agents").json()
    assert {agent["id"] for agent in baseline["agents"]} >= set(agent_ids)

    nodes = _count_calls(monkeypatch, app.state.registry, "monitor_nodes")
    placements = _count_calls(monkeypatch, app.state.agent_placement_store, "list_placements")
    agents = _count_calls(monkeypatch, app.state.agent_store, "get_agent")

    listed = client.get("/api/v1/admin/agents").json()

    assert listed == baseline
    assert nodes[0] == 1
    assert placements[0] == 1
    assert agents[0] == 0


def test_team_list_reads_each_member_and_the_fleet_once(roster, monkeypatch) -> None:
    app, client, agent_ids = roster
    baseline = client.get("/api/v1/admin/teams").json()
    assert [member["id"] for member in baseline["teams"][0]["members"]] == agent_ids
    assert baseline["teams"][0]["lead"]["id"] == agent_ids[0]
    assert baseline["teams"][0]["members"][0]["availability"] == "ready"

    nodes = _count_calls(monkeypatch, app.state.registry, "monitor_nodes")
    placements = _count_calls(monkeypatch, app.state.agent_placement_store, "list_placements")
    agents = _count_calls(monkeypatch, app.state.agent_store, "get_agent")
    batches = _count_calls(monkeypatch, app.state.agent_store, "get_agents_by_ids")

    listed = client.get("/api/v1/admin/teams").json()

    assert listed == baseline
    assert nodes[0] == 1
    assert placements[0] == 1
    assert agents[0] == 0
    assert batches[0] == 1


def test_placement_list_reads_the_fleet_once(roster, monkeypatch) -> None:
    app, client, agent_ids = roster
    store = app.state.agent_store
    agent = store.get_agent(agent_ids[0])
    for _ in range(3):
        node = _register_node(app, new_database_id())
        app.state.agent_placement_store.create_placement(agent, node["id"], {"desiredState": "removed"})
    baseline = client.get("/api/v1/admin/agent-placements").json()
    assert len(baseline["placements"]) == len(agent_ids) + 3

    nodes = _count_calls(monkeypatch, app.state.registry, "monitor_nodes")
    agents = _count_calls(monkeypatch, store, "get_agent")
    batches = _count_calls(monkeypatch, store, "get_agents_by_ids")
    listed = client.get("/api/v1/admin/agent-placements").json()

    assert listed == baseline
    assert nodes[0] == 1
    assert agents[0] == 0
    assert batches[0] == 1


def test_personal_teams_only_read_member_placements_and_related_nodes(roster, monkeypatch):
    app, client, agent_ids = roster
    _register_node(app, "unrelated_node")
    assert client.post("/api/v1/auth/login", json={"username": "alice", "password": "userpass"}).status_code == 200
    path = "/api/v1/teams?view=summary&format=compact"
    baseline = client.get(path).json()
    fleet_reads = _count_calls(monkeypatch, app.state.registry, "monitor_nodes")
    find_placements = app.state.agent_placement_store.list_placements
    find_nodes = app.state.daemon_store.list_nodes_for_computers
    filters = []
    related = []

    def scoped_placements(**kwargs):
        filters.append(kwargs)
        return find_placements(**kwargs)

    def scoped_nodes(computers, node_ids):
        rows = find_nodes(computers, node_ids)
        related.append([row["id"] for row in rows])
        return rows

    monkeypatch.setattr(app.state.agent_placement_store, "list_placements", scoped_placements)
    monkeypatch.setattr(app.state.daemon_store, "list_nodes_for_computers", scoped_nodes)
    result = client.get(path)
    assert result.status_code == 200
    assert result.json() == baseline
    assert all(member["availability"] == "ready" for member in baseline["memberDirectory"])
    assert fleet_reads == [0]
    assert len(filters) == 1
    assert set(filters[0]["agent_ids"]) == set(agent_ids)
    assert related == [["node_a"]]


# ── Fix 3: the session cookie resolves from the cache between store changes ──


def test_session_cookie_is_resolved_once_and_dropped_on_logout(monkeypatch) -> None:
    monkeypatch.setenv("RELAY_ADMIN_TOKEN", "admin_token")
    with TemporaryDirectory() as root:
        app = create_app(root)
        client = TestClient(app)
        _bootstrap(client)
        SESSION_ACCOUNTS.invalidate_all()
        lookups = _count_calls(monkeypatch, app.state.auth_store, "get_session_by_token")

        assert client.get("/api/v1/auth/me").status_code == 200
        assert client.get("/api/v1/auth/me").status_code == 200
        assert client.get("/api/v1/threads").status_code == 200
        assert lookups[0] == 1

        assert client.post("/api/v1/auth/logout").status_code == 200
        assert client.get("/api/v1/auth/me").status_code == 401


def test_preference_change_is_visible_on_the_next_request(monkeypatch) -> None:
    monkeypatch.setenv("RELAY_ADMIN_TOKEN", "admin_token")
    with TemporaryDirectory() as root:
        client = TestClient(create_app(root))
        _bootstrap(client)
        assert client.get("/api/v1/auth/me").json()["user"]["theme"] != "dark"

        assert client.patch("/api/v1/auth/preferences", json={"theme": "dark"}).status_code == 200

        assert client.get("/api/v1/auth/me").json()["user"]["theme"] == "dark"


def test_auth_status_asks_the_store_once_after_accounts_exist(monkeypatch) -> None:
    monkeypatch.setenv("RELAY_ADMIN_TOKEN", "admin_token")
    with TemporaryDirectory() as root:
        app = create_app(root)
        client = TestClient(app)
        assert client.get("/api/v1/auth/status").json()["requiresBootstrap"] is True
        _bootstrap(client)
        assert client.get("/api/v1/auth/status").json()["requiresBootstrap"] is False

        checks = _count_calls(monkeypatch, app.state.auth_store, "has_accounts")
        assert client.get("/api/v1/auth/status").json()["requiresBootstrap"] is False
        assert checks[0] == 0


# ── Fix 4: task lists remain complete unless explicitly limited ────────────────────────────────


def test_task_summary_without_a_limit_preserves_completeness(monkeypatch) -> None:
    monkeypatch.setenv("RELAY_ADMIN_TOKEN", "admin_token")
    with TemporaryDirectory() as root:
        app = create_app(root)
        client = TestClient(app)
        _bootstrap(client)
        seen: list[int | None] = []
        for name in ("list_task_summaries", "list_tasks"):
            original = getattr(app.state.task_store, name)

            def recording(*args: Any, _original=original, **kwargs: Any) -> Any:
                seen.append(kwargs.get("limit"))
                return _original(*args, **kwargs)

            monkeypatch.setattr(app.state.task_store, name, recording)

        query = "?view=summary"
        assert client.get(f"/api/v1/tasks{query}").status_code == 200
        assert client.get(f"/api/v1/tasks{query}{'&' if query else '?'}limit=900").status_code == 200
        assert client.get(f"/api/v1/tasks{query}{'&' if query else '?'}limit=0").status_code == 200
        assert client.get(f"/api/v1/tasks{query}{'&' if query else '?'}limit=x").status_code == 400

        assert seen == [None, 500, 1]


@pytest.mark.parametrize("query", ["", "?view=summary"])
def test_task_list_keeps_older_tasks_and_routines_beyond_200(monkeypatch, query) -> None:
    monkeypatch.setenv("RELAY_ADMIN_TOKEN", "admin_token")
    with TemporaryDirectory() as root:
        app = create_app(root)
        client = TestClient(app)
        _bootstrap(client)
        owner = client.get("/api/v1/auth/me").json()["user"]["userId"]
        expected = {
            app.state.task_store.create_task({
                "title": f"Task {index}",
                "isRoutine": index == 0,
                "ownerUserId": owner,
            })["id"]
            for index in range(205)
        }
        response = client.get(f"/api/v1/tasks{query}")
        assert response.status_code == 200
        tasks = response.json()["tasks"]
        cursor = response.json().get("nextCursor")
        while cursor:
            page = client.get("/api/v1/tasks", params={"cursor": cursor}).raise_for_status().json()
            tasks.extend(page["tasks"])
            cursor = page["nextCursor"]
        assert {task["id"] for task in tasks} == expected
        assert any(task["isRoutine"] for task in tasks)


def test_default_task_list_pages_without_replaying_history(roster, monkeypatch):
    app, client, _ = roster
    store = app.state.task_store
    owner = client.get("/api/v1/auth/me").json()["user"]["userId"]
    expected = []
    for index in range(3):
        task = store.create_task({"title": str(index), "ownerUserId": owner})
        store.record_activity(task["id"], "Past activity")
        expected.append(task["id"])

    def reject_full_list(**_):
        pytest.fail("Task listing must not replay every Task")

    monkeypatch.setattr(store, "list_tasks", reject_full_list)
    page = client.get("/api/v1/tasks", params={"limit": 2}).raise_for_status().json()
    assert len(page["tasks"]) == 2 and page["nextCursor"]
    assert all("events" not in task and task["eventCount"] >= 2 for task in page["tasks"])
    rest = client.get("/api/v1/tasks", params={"cursor": page["nextCursor"]}).raise_for_status().json()
    assert rest["nextCursor"] is None
    assert {task["id"] for task in page["tasks"] + rest["tasks"]} == set(expected)


# ── Fix 6: large answers are gzipped; the UI revalidates ─────────────────


def test_large_json_answers_are_gzipped_and_still_conditional(monkeypatch) -> None:
    monkeypatch.setenv("RELAY_ADMIN_TOKEN", "admin_token")
    with TemporaryDirectory() as root:
        app = create_app(root)
        client = TestClient(app)
        _bootstrap(client)
        for index in range(30):
            assert client.post("/api/v1/tasks", json={"title": f"task {index} " + "x" * 80}).status_code == 201

        listed = client.get("/api/v1/tasks?limit=30", headers={"Accept-Encoding": "gzip"})
        assert listed.status_code == 200
        assert listed.headers["content-encoding"] == "gzip"
        assert len(listed.json()["tasks"]) == 30
        etag = listed.headers["etag"]

        again = client.get(
            "/api/v1/tasks?limit=30",
            headers={"Accept-Encoding": "gzip", "If-None-Match": etag},
        )
        assert again.status_code == 304


# ── Fix 9: the dashboard answers from a short cache ──────────────────────


def test_dashboard_answers_are_cached_per_window_for_a_short_while(monkeypatch) -> None:
    monkeypatch.setenv("RELAY_ADMIN_TOKEN", "admin_token")
    with TemporaryDirectory() as root:
        app = create_app(root)
        client = TestClient(app)
        _bootstrap(client)
        DASHBOARD_CACHE.clear()
        sessions = _count_calls(monkeypatch, app.state.session_store, "dashboard_session_metrics")
        tokens = _count_calls(monkeypatch, app.state.session_store, "dashboard_token_metrics")

        first = client.get("/api/v1/admin/dashboard/sessions").json()
        assert client.get("/api/v1/admin/dashboard/sessions").json() == first
        assert sessions[0] == 1

        utc = client.get("/api/v1/admin/dashboard/tokens").json()
        assert client.get("/api/v1/admin/dashboard/tokens").json() == utc
        tokyo = client.get("/api/v1/admin/dashboard/tokens?tz=Asia/Tokyo").json()
        assert tokyo["timeZone"] == "Asia/Tokyo"
        assert tokens[0] == 2

        DASHBOARD_CACHE.clear()
        assert client.get("/api/v1/admin/dashboard/sessions").status_code == 200
        assert sessions[0] == 2
