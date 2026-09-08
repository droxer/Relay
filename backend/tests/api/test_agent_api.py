from __future__ import annotations

from collections.abc import Iterator
from tempfile import TemporaryDirectory

import pytest
from fastapi.testclient import TestClient
from relay.app import create_app
from relay.core.computer_identity import computer_id
from relay.persistence.store_common import _write_json
from relay.services.node_agents import sync_node_agents
from relay.sessions.controller import SessionController


def _bootstrap_admin(client: TestClient) -> None:
    response = client.post(
        "/api/v1/auth/bootstrap",
        json={"token": "admin_token", "username": "admin", "password": "kestrel-vault-7719"},
    )
    assert response.status_code == 200


def _register_alice_client(
    monkeypatch: pytest.MonkeyPatch, *, node_status: str
) -> Iterator[tuple[TestClient, dict[str, object]]]:
    monkeypatch.setenv("RELAY_ADMIN_TOKEN", "admin_token")
    with TemporaryDirectory() as root:
        app = create_app(root)
        client = TestClient(app)
        _bootstrap_admin(client)
        assert (
            client.post(
                "/api/v1/admin/employees",
                json={
                    "employeeId": "alice",
                    "username": "alice",
                    "password": "userpass",
                    "displayName": "Alice",
                },
            ).status_code
            == 201
        )
        node = app.state.registry.register(
            {
                "sandboxId": "node_alice",
                "employeeId": "alice",
                "workspaceId": "machine-alice",
                "token": "node_token",
                "workspacePath": "/workspace/alice",
                "nodeLocation": "employee-device",
                "protocolVersion": 1,
                "supportedAgents": ["claude"],
                "capabilities": ["thread-workspaces"],
                "status": node_status,
            }
        )
        assert client.post("/api/v1/auth/logout").status_code == 200
        assert (
            client.post(
                "/api/v1/auth/login",
                json={"username": "alice", "password": "userpass"},
            ).status_code
            == 200
        )
        yield client, {**node, "computerId": computer_id(node)}


@pytest.fixture
def client_with_node(
    monkeypatch: pytest.MonkeyPatch,
) -> Iterator[tuple[TestClient, dict[str, object]]]:
    yield from _register_alice_client(monkeypatch, node_status="ready")


@pytest.fixture
def client_with_offline_node(
    monkeypatch: pytest.MonkeyPatch,
) -> Iterator[tuple[TestClient, dict[str, object]]]:
    yield from _register_alice_client(monkeypatch, node_status="stopped")


def _birth_computer_id(
    client: TestClient,
    employee_id: str,
    executor_kind: str,
    *,
    status: str = "stopped",
) -> str:
    """Register (or extend) this employee's offline test computer and return
    its computerId. Offline by default so creation succeeds without
    auto-placing the agent — callers that need a live node pass
    status="ready" explicitly.
    """
    node_id = f"admin_test_node_{employee_id}"
    existing = client.app.state.registry.get(node_id)
    # supportedAgents is a registration-payload field only; the registry
    # never persists it on the stored node record (it's folded into the
    # "agents" status dict and then dropped). Reading it back off `existing`
    # is always empty, so re-registering here would silently forget every
    # runtime a prior call had already made ready. Read the runtimes this
    # node is actually ready for instead.
    existing_ready = {
        kind
        for kind, status_value in (existing or {}).get("agents", {}).items()
        if status_value == "ready"
    }
    node = client.app.state.registry.register(
        {
            "sandboxId": node_id,
            "employeeId": employee_id,
            "workspaceId": f"machine-{employee_id}",
            "token": "node_token",
            "workspacePath": f"/workspace/{employee_id}",
            "protocolVersion": 1,
            "supportedAgents": sorted(existing_ready | {executor_kind}),
            "capabilities": ["thread-workspaces"],
            "status": status,
        }
    )
    return computer_id(node)


def _place_if_needed(
    client: TestClient, agent_id: str, node_id: str, extra: dict | None = None
) -> dict:
    """Place `agent_id` on `node_id`, unless creation already auto-placed it
    on a live computer (which would make a second POST a 409 conflict).
    """
    placements = client.app.state.agent_placement_store.list_placements(
        agent_id=agent_id
    )
    if placements:
        return placements[0]
    response = client.post(
        f"/api/v1/admin/agents/{agent_id}/placements",
        json={"daemonNodeId": node_id, **(extra or {})},
    )
    assert response.status_code == 201
    return response.json()["placement"]


def test_admin_manages_agents_and_employee_lists_own_agents(
    monkeypatch,
) -> None:
    monkeypatch.setenv("RELAY_ADMIN_TOKEN", "admin_token")
    with TemporaryDirectory() as root:
        client = TestClient(create_app(root))
        _bootstrap_admin(client)
        employee = client.post(
            "/api/v1/admin/employees",
            json={
                "employeeId": "alice",
                "username": "alice",
                "password": "userpass",
                "displayName": "Alice",
            },
        )
        assert employee.status_code == 201
        computer_id_alice = _birth_computer_id(client, "alice", "claude")

        researcher = client.post(
            "/api/v1/admin/agents",
            json={
                "supervisorEmployeeId": "alice",
                "displayName": "Researcher",
                "executorKind": "claude",
                "defaultRole": "planner",
                "computerId": computer_id_alice,
            },
        )
        reviewer = client.post(
            "/api/v1/admin/agents",
            json={
                "supervisorEmployeeId": "alice",
                "displayName": "Reviewer",
                "executorKind": "claude",
                "defaultRole": "reviewer",
                "computerId": computer_id_alice,
            },
        )
        assert researcher.status_code == reviewer.status_code == 201

        assert client.post("/api/v1/auth/logout").status_code == 200
        assert (
            client.post(
                "/api/v1/auth/login", json={"username": "alice", "password": "userpass"}
            ).status_code
            == 200
        )
        own_agents = client.get("/api/v1/agents")

        assert own_agents.status_code == 200
        assert {agent["displayName"] for agent in own_agents.json()["agents"]} == {
            "Researcher",
            "Reviewer",
        }
        assert (
            client.get(
                f"/api/v1/agents/{researcher.json()['agent']['id']}/artifacts"
            ).status_code
            == 404
        )


def test_employee_agent_admin_routes_require_admin(monkeypatch) -> None:
    monkeypatch.setenv("RELAY_ADMIN_TOKEN", "admin_token")
    with TemporaryDirectory() as root:
        client = TestClient(create_app(root))

        assert client.get("/api/v1/admin/agents").status_code == 401
        assert (
            client.post(
                "/api/v1/admin/agents",
                json={
                    "supervisorEmployeeId": "alice",
                    "displayName": "Builder",
                    "executorKind": "codex",
                    "defaultRole": "implementer",
                },
            ).status_code
            == 401
        )


def test_unprovisioned_daemon_registration_cannot_mint_logical_agents(
    monkeypatch,
) -> None:
    monkeypatch.setenv("RELAY_ADMIN_TOKEN", "admin_token")
    with TemporaryDirectory() as root:
        app = create_app(root)
        admin_client = TestClient(app)
        _bootstrap_admin(admin_client)
        assert (
            admin_client.post(
                "/api/v1/admin/employees",
                json={
                    "employeeId": "alice",
                    "username": "alice",
                    "password": "userpass",
                },
            ).status_code
            == 201
        )

        daemon_client = TestClient(app)
        registered = daemon_client.post(
            "/api/v1/daemon-node-registrations",
            headers={"Authorization": "Bearer untrusted_ui_token"},
            json={
                "sandboxId": "unprovisioned",
                "employeeId": "alice",
                "token": "node_token",
                "workspacePath": "/workspace/alice",
                "nodeLocation": "employee-device",
                "protocolVersion": 1,
                "supportedAgents": ["codex"],
                "capabilities": ["thread-workspaces"],
                "status": "stopped",
            },
        )

        assert registered.status_code == 200
        assert "employeeId" not in registered.json()
        restarted_app = create_app(root)
        restarted_daemon = TestClient(restarted_app)
        heartbeat = restarted_daemon.post(
            "/api/v1/daemon-node-registrations",
            headers={"Authorization": "Bearer untrusted_ui_token"},
            json={
                "sandboxId": "unprovisioned",
                "employeeId": "alice",
                "token": "node_token",
                "workspacePath": "/workspace/alice",
                "nodeLocation": "employee-device",
                "protocolVersion": 1,
                "supportedAgents": ["codex"],
                "capabilities": ["thread-workspaces"],
                "status": "ready",
            },
        )
        assert heartbeat.status_code == 200
        assert "employeeId" not in heartbeat.json()
        assert "nodeLocation" not in heartbeat.json()
        restarted_admin = TestClient(restarted_app)
        assert (
            restarted_admin.post(
                "/api/v1/auth/login",
                json={"username": "admin", "password": "kestrel-vault-7719"},
            ).status_code
            == 200
        )
        assert (
            restarted_admin.get("/api/v1/admin/agents?employeeId=alice").json()[
                "agents"
            ]
            == []
        )


def test_control_plane_provisioned_node_registration_does_not_materialize_agents(
    monkeypatch,
) -> None:
    """Registering a computer no longer conjures an agent — agents are only
    declared explicitly by employees (POST /agents)."""
    monkeypatch.setenv("RELAY_ADMIN_TOKEN", "admin_token")
    with TemporaryDirectory() as root:
        client = TestClient(create_app(root))
        _bootstrap_admin(client)
        assert (
            client.post(
                "/api/v1/admin/employees",
                json={
                    "employeeId": "alice",
                    "username": "alice",
                    "password": "userpass",
                },
            ).status_code
            == 201
        )
        provisioned = client.post(
            "/api/v1/admin/daemon-nodes",
            json={
                "employeeId": "alice",
                "workspacePath": "/workspace/alice",
                "sandboxMode": "boxlite",
            },
        ).json()

        registered = client.post(
            "/api/v1/daemon-node-registrations",
            json={
                "sandboxId": provisioned["node"]["id"],
                "token": provisioned["nodeToken"],
                "workspacePath": "/workspace/alice",
                "protocolVersion": 1,
                "supportedAgents": ["codex"],
                "capabilities": ["thread-workspaces"],
                "status": "ready",
            },
        )

        assert registered.status_code == 200
        agents = client.get("/api/v1/admin/agents?employeeId=alice").json()["agents"]
        assert agents == []


def test_agent_policies_are_rejected_until_runtime_enforcement_exists(
    monkeypatch,
) -> None:
    monkeypatch.setenv("RELAY_ADMIN_TOKEN", "admin_token")
    with TemporaryDirectory() as root:
        client = TestClient(create_app(root))
        _bootstrap_admin(client)
        assert (
            client.post(
                "/api/v1/admin/employees",
                json={
                    "employeeId": "alice",
                    "username": "alice",
                    "password": "userpass",
                },
            ).status_code
            == 201
        )
        computer_id_alice = _birth_computer_id(client, "alice", "codex")

        rejected_create = client.post(
            "/api/v1/admin/agents",
            json={
                "supervisorEmployeeId": "alice",
                "displayName": "Restricted",
                "executorKind": "codex",
                "defaultRole": "implementer",
                "toolPolicy": {"allowedTools": ["read"]},
                "computerId": computer_id_alice,
            },
        )
        assert rejected_create.status_code == 400
        assert "runtime enforcement" in rejected_create.json()["detail"]

        agent = client.post(
            "/api/v1/admin/agents",
            json={
                "supervisorEmployeeId": "alice",
                "displayName": "Builder",
                "executorKind": "codex",
                "defaultRole": "implementer",
                "computerId": computer_id_alice,
            },
        ).json()["agent"]
        rejected_update = client.patch(
            f"/api/v1/admin/agents/{agent['id']}",
            json={"modelPolicy": {"model": "example"}},
        )
        assert rejected_update.status_code == 400
        assert "runtime enforcement" in rejected_update.json()["detail"]


def test_legacy_sandbox_run_blocks_unenforced_agent_policy(monkeypatch) -> None:
    monkeypatch.setenv("RELAY_ADMIN_TOKEN", "admin_token")
    with TemporaryDirectory() as root:
        app = create_app(root)
        client = TestClient(app)
        _bootstrap_admin(client)
        assert (
            client.post(
                "/api/v1/admin/employees",
                json={
                    "employeeId": "alice",
                    "username": "alice",
                    "password": "userpass",
                },
            ).status_code
            == 201
        )
        app.state.registry.register(
            {
                "sandboxId": "node_a",
                "employeeId": "alice",
                "token": "node_token",
                "workspacePath": "/workspace/alice",
                "protocolVersion": 1,
                "supportedAgents": ["codex"],
                "capabilities": ["thread-workspaces"],
                "status": "ready",
            }
        )
        agent = app.state.agent_store.ensure_compatibility_agent(
            "alice", "codex", "node_a"
        )
        app.state.agent_placement_store.create_placement(agent, "node_a")
        _write_json(
            app.state.agent_store._snapshot_path(agent["id"]),
            {**agent, "toolPolicy": {"allowedTools": ["read"]}},
        )
        assert client.post("/api/v1/auth/logout").status_code == 200
        assert (
            client.post(
                "/api/v1/auth/login", json={"username": "alice", "password": "userpass"}
            ).status_code
            == 200
        )

        response = client.post(
            "/api/v1/sandboxes/node_a/runs",
            json={
                "taskGoal": "Blocked legacy policy",
                "assignments": [{"agent": "codex"}],
            },
        )

        assert response.status_code == 409
        assert "agent_policy_unsupported" in response.json()["detail"]


def test_employee_updates_own_agent_meta(monkeypatch) -> None:
    monkeypatch.setenv("RELAY_ADMIN_TOKEN", "admin_token")
    with TemporaryDirectory() as root:
        client = TestClient(create_app(root))
        _bootstrap_admin(client)
        employee = client.post(
            "/api/v1/admin/employees",
            json={
                "employeeId": "alice",
                "username": "alice",
                "password": "userpass",
                "displayName": "Alice",
            },
        )
        assert employee.status_code == 201
        researcher = client.post(
            "/api/v1/admin/agents",
            json={
                "supervisorEmployeeId": "alice",
                "displayName": "Researcher",
                "executorKind": "claude",
                "defaultRole": "planner",
                "computerId": _birth_computer_id(client, "alice", "claude"),
            },
        ).json()["agent"]

        assert client.post("/api/v1/auth/logout").status_code == 200
        assert (
            client.post(
                "/api/v1/auth/login", json={"username": "alice", "password": "userpass"}
            ).status_code
            == 200
        )

        updated = client.patch(
            f"/api/v1/agents/{researcher['id']}",
            json={
                "displayName": "Analyst",
                "instructions": "Cite primary sources.",
            },
        )
        assert updated.status_code == 200
        payload = updated.json()["agent"]
        assert payload["displayName"] == "Analyst"
        assert payload["instructions"] == "Cite primary sources."

        forbidden_field = client.patch(
            f"/api/v1/agents/{researcher['id']}",
            json={"enabled": False},
        )
        assert forbidden_field.status_code == 400

        assert client.post("/api/v1/auth/logout").status_code == 200
        assert (
            client.post(
                "/api/v1/auth/login",
                json={"username": "admin", "password": "kestrel-vault-7719"},
            ).status_code
            == 200
        )
        bob = client.post(
            "/api/v1/admin/employees",
            json={
                "employeeId": "bob",
                "username": "bob",
                "password": "userpass",
            },
        )
        assert bob.status_code == 201
        assert client.post("/api/v1/auth/logout").status_code == 200
        assert (
            client.post(
                "/api/v1/auth/login", json={"username": "bob", "password": "userpass"}
            ).status_code
            == 200
        )
        forbidden_owner = client.patch(
            f"/api/v1/agents/{researcher['id']}",
            json={"displayName": "Hijacked"},
        )
        assert forbidden_owner.status_code == 403


def test_admin_places_agents_on_different_runtime_nodes(monkeypatch) -> None:
    monkeypatch.setenv("RELAY_ADMIN_TOKEN", "admin_token")
    with TemporaryDirectory() as root:
        app = create_app(root)
        client = TestClient(app)
        _bootstrap_admin(client)
        assert (
            client.post(
                "/api/v1/admin/employees",
                json={
                    "employeeId": "alice",
                    "username": "alice",
                    "password": "userpass",
                },
            ).status_code
            == 201
        )
        for node_id, executor in (("node_a", "claude"), ("node_b", "codex")):
            app.state.registry.register(
                {
                    "sandboxId": node_id,
                    "employeeId": "alice",
                    "token": f"token_{node_id}",
                    "protocolVersion": 1,
                    "supportedAgents": [executor],
                    "capabilities": ["thread-workspaces"],
                    "status": "ready",
                }
            )

        client.post(
            "/api/v1/admin/agents",
            json={
                "supervisorEmployeeId": "alice",
                "displayName": "Researcher",
                "executorKind": "claude",
                "defaultRole": "implementer",
                "computerId": "node:node_a",
            },
        )
        client.post(
            "/api/v1/admin/agents",
            json={
                "supervisorEmployeeId": "alice",
                "displayName": "Builder",
                "executorKind": "codex",
                "defaultRole": "implementer",
                "computerId": "node:node_b",
            },
        )
        # Both computers are live, so creation already auto-placed each
        # agent on its one matching node.
        agents = client.get("/api/v1/admin/agents?employeeId=alice").json()["agents"]
        assert {agent["availability"] for agent in agents} == {"ready"}
        assert {agent["placements"][0]["daemonNodeId"] for agent in agents} == {
            "node_a",
            "node_b",
        }


def test_agent_placements_describe_managed_and_local_runtime_nodes(monkeypatch) -> None:
    monkeypatch.setenv("RELAY_ADMIN_TOKEN", "admin_token")
    with TemporaryDirectory() as root:
        app = create_app(root)
        client = TestClient(app)
        _bootstrap_admin(client)
        assert (
            client.post(
                "/api/v1/admin/employees",
                json={
                    "employeeId": "alice",
                    "username": "alice",
                    "password": "userpass",
                },
            ).status_code
            == 201
        )
        local_runtime = client.post(
            "/api/v1/admin/daemon-nodes",
            json={
                "employeeId": "alice",
                "workspacePath": "/Users/alice/relay",
                "sandboxMode": "none",
                "nodeLocation": "employee-device",
            },
        ).json()
        local_node_id = local_runtime["node"]["id"]
        app.state.registry.register(
            {
                "sandboxId": local_node_id,
                "employeeId": "alice",
                "token": local_runtime["nodeToken"],
                "workspacePath": "/Users/alice/relay",
                "sandboxMode": "none",
                "protocolVersion": 1,
                "supportedAgents": ["codex"],
                "capabilities": ["thread-workspaces"],
                "status": "ready",
            }
        )
        managed = client.post(
            "/api/v1/admin/managed-nodes",
            json={"employeeId": "alice", "displayName": "Alice managed node"},
        ).json()["node"]
        attempt = client.post(
            f"/api/v1/admin/managed-nodes/{managed['id']}/attempts"
        ).json()
        enrolled = client.post(
            "/api/v1/daemon-node-enrollments",
            json={"workspacePath": "/workspace/alice"},
            headers={"Authorization": f"Enrollment {attempt['enrollmentCredential']}"},
        ).json()
        assert (
            client.post(
                "/api/v1/daemon-node-registrations",
                json={
                    "sandboxId": enrolled["sandboxId"],
                    "token": enrolled["token"],
                    "workspacePath": "/workspace/alice",
                    "workspaceId": "employee:alice:home",
                    "sandboxMode": "boxlite",
                    "protocolVersion": 1,
                    "supportedAgents": ["codex"],
                    "capabilities": ["thread-workspaces"],
                    "status": "ready",
                },
            ).status_code
            == 200
        )
        # One agent lives on one computer, so a managed and a local runtime are
        # described through two agents — one placed on each.
        managed_agent = client.post(
            "/api/v1/admin/agents",
            json={
                "supervisorEmployeeId": "alice",
                "displayName": "Managed Builder",
                "executorKind": "codex",
                "defaultRole": "implementer",
                "computerId": computer_id(
                    app.state.registry.get(enrolled["sandboxId"])
                ),
            },
        ).json()["agent"]
        local_agent = client.post(
            "/api/v1/admin/agents",
            json={
                "supervisorEmployeeId": "alice",
                "displayName": "Local Builder",
                "executorKind": "codex",
                "defaultRole": "implementer",
                "computerId": computer_id(app.state.registry.get(local_node_id)),
            },
        ).json()["agent"]

        # Both computers were already live, so creation auto-placed each
        # agent; set the priority this test cares about on that placement
        # instead of creating a second (and now conflicting) one.
        def _set_priority(agent_id: str, node_id: str, priority: int) -> None:
            placements = client.app.state.agent_placement_store.list_placements(
                agent_id=agent_id
            )
            if placements:
                assert (
                    client.patch(
                        f"/api/v1/admin/agent-placements/{placements[0]['id']}",
                        json={"priority": priority},
                    ).status_code
                    == 200
                )
            else:
                assert (
                    client.post(
                        f"/api/v1/admin/agents/{agent_id}/placements",
                        json={"daemonNodeId": node_id, "priority": priority},
                    ).status_code
                    == 201
                )

        _set_priority(managed_agent["id"], enrolled["sandboxId"], 100)
        _set_priority(local_agent["id"], local_node_id, 200)
        assert (
            client.patch(
                f"/api/v1/daemon-nodes/{local_node_id}",
                json={"displayName": "Alice's MacBook"},
            ).status_code
            == 200
        )

        listed = {
            item["id"]: item
            for item in client.get(
                "/api/v1/admin/agents?supervisorEmployeeId=alice"
            ).json()["agents"]
        }
        managed_placement = listed[managed_agent["id"]]["placements"][0]
        local_placement = listed[local_agent["id"]]["placements"][0]

        assert managed_placement["nodeDisplayName"] == "Alice managed node"
        assert managed_placement["nodeOwnership"] == "managed"
        assert managed_placement["nodeSandboxMode"] == "boxlite"
        assert local_placement["nodeDisplayName"] == "Alice's MacBook"
        assert local_placement["nodeOwnership"] == "employee-device"
        assert local_placement["nodeSandboxMode"] == "none"


def test_employee_dispatches_work_by_logical_agent_id(monkeypatch) -> None:
    monkeypatch.setenv("RELAY_ADMIN_TOKEN", "admin_token")
    with TemporaryDirectory() as root:
        app = create_app(root)
        client = TestClient(app)
        _bootstrap_admin(client)
        assert (
            client.post(
                "/api/v1/admin/employees",
                json={
                    "employeeId": "alice",
                    "username": "alice",
                    "password": "userpass",
                },
            ).status_code
            == 201
        )
        app.state.registry.register(
            {
                "sandboxId": "node_a",
                "employeeId": "alice",
                "token": "node_token",
                "workspacePath": "/workspace/alice",
                "protocolVersion": 1,
                "supportedAgents": ["codex"],
                "capabilities": ["thread-workspaces"],
                "status": "ready",
            }
        )
        agent = client.post(
            "/api/v1/admin/agents",
            json={
                "supervisorEmployeeId": "alice",
                "displayName": "Builder",
                "executorKind": "codex",
                "defaultRole": "implementer",
                "computerId": "node:node_a",
            },
        ).json()["agent"]
        placement = _place_if_needed(client, agent["id"], "node_a")

        assert client.post("/api/v1/auth/logout").status_code == 200
        assert (
            client.post(
                "/api/v1/auth/login", json={"username": "alice", "password": "userpass"}
            ).status_code
            == 200
        )
        updated = client.patch(
            f"/api/v1/agents/{agent['id']}",
            json={"instructions": "Use the repository tests as evidence."},
        )
        assert updated.status_code == 200
        assert updated.json()["agent"]["availability"] == "ready"
        response = client.post(
            "/api/v1/agent-runs",
            json={
                "taskGoal": "Build the feature",
                "assignments": [{"agentId": agent["id"]}],
                "idempotencyKey": "telegram:chat_1:42",
            },
        )

        assert response.status_code == 202
        duplicate = client.post(
            "/api/v1/agent-runs",
            json={
                "taskGoal": "Build the feature",
                "assignments": [{"agentId": agent["id"]}],
                "idempotencyKey": "telegram:chat_1:42",
            },
        )
        assert duplicate.status_code == 202
        assert duplicate.json()["id"] == response.json()["id"]
        run = response.json()["agentRuns"][0]
        assert run["logicalAgentId"] == agent["id"]
        assert run["daemonNodeId"] == "node_a"
        monitor_node = next(
            node
            for node in client.get("/api/v1/daemon-nodes").json()["nodes"]
            if node["id"] == "node_a"
        )
        active_run = next(
            active
            for active in monitor_node["activeRuns"]
            if active["runId"] == run["id"]
        )
        assert active_run["logicalAgentId"] == agent["id"]
        assert active_run["placementId"] == placement["id"]
        commands = app.state.daemon_store.take_queued_commands("node_a")
        assert len(commands) == 1
        command = commands[0]["command"]
        assert command["logicalAgentId"] == agent["id"]
        assert command["state"]["agent_display_name"] == "Builder"
        assert command["state"]["agent_instructions"] == (
            "Use the repository tests as evidence."
        )
        assert "mode" not in command
        assert "adaptive_execution" not in command["state"]
        assert client.post("/api/v1/auth/logout").status_code == 200
        assert (
            client.post(
                "/api/v1/auth/login",
                json={"username": "admin", "password": "kestrel-vault-7719"},
            ).status_code
            == 200
        )
        deleting = client.delete(f"/api/v1/admin/agents/{agent['id']}")
        assert deleting.status_code == 409
        assert not app.state.agent_store.get_agent(agent["id"]).get("deletedAt")


def test_mentioning_an_agent_grows_the_room_and_later_messages_reach_it(
    monkeypatch,
) -> None:
    monkeypatch.setenv("RELAY_ADMIN_TOKEN", "admin_token")
    with TemporaryDirectory() as root:
        app = create_app(root)
        client = TestClient(app)
        _bootstrap_admin(client)
        node = app.state.registry.register(
            {
                "sandboxId": "node_admin",
                "employeeId": "admin",
                "token": "node_token",
                "workspacePath": "/workspace/admin",
                "protocolVersion": 1,
                "supportedAgents": ["codex", "claude"],
                "capabilities": ["thread-workspaces"],
                "status": "ready",
            }
        )
        computer = computer_id(node)
        owner = app.state.agent_store.create_agent(
            "admin",
            {
                "displayName": "Codex",
                "executorKind": "codex",
                "defaultRole": "implementer",
                "computerId": computer,
            },
        )
        outsider = app.state.agent_store.create_agent(
            "admin",
            {
                "displayName": "Claude",
                "executorKind": "claude",
                "defaultRole": "implementer",
                "computerId": computer,
            },
        )
        sync_node_agents(app.state, node)
        session = app.state.session_store.create_session(
            {
                "daemonNodeId": node["id"],
                "workspacePath": "/workspace/admin",
                "ownerEmployeeId": "admin",
                "ownerAgentId": owner["id"],
                "taskGoal": "Keep one room",
            }
        )

        response = client.post(
            f"/api/v1/threads/{session['id']}/messages",
            json={
                "text": f"@{outsider['displayName']} take a look",
                "intent": "accomplish",
                "addressAgentIds": [outsider["id"]],
            },
        )

        assert response.status_code == 202
        assert app.state.session_store.get_session(session["id"])[
            "participantAgentIds"
        ] == [owner["id"], outsider["id"]]


def test_leading_named_mention_cannot_silently_dispatch_to_the_room(
    monkeypatch,
) -> None:
    monkeypatch.setenv("RELAY_ADMIN_TOKEN", "admin_token")
    with TemporaryDirectory() as root:
        app = create_app(root)
        client = TestClient(app)
        _bootstrap_admin(client)
        node = app.state.registry.register(
            {
                "sandboxId": "node_admin",
                "employeeId": "admin",
                "token": "node_token",
                "workspacePath": "/workspace/admin",
                "protocolVersion": 1,
                "supportedAgents": ["claude", "kimi"],
                "capabilities": ["thread-workspaces"],
                "status": "ready",
            }
        )
        computer = computer_id(node)
        owner = app.state.agent_store.create_agent(
            "admin",
            {
                "displayName": "Claude",
                "executorKind": "claude",
                "defaultRole": "implementer",
                "computerId": computer,
            },
        )
        kimi = app.state.agent_store.create_agent(
            "admin",
            {
                "displayName": "Kimi",
                "executorKind": "kimi",
                "defaultRole": "implementer",
                "computerId": computer,
            },
        )
        sync_node_agents(app.state, node)
        session = app.state.session_store.create_session(
            {
                "daemonNodeId": node["id"],
                "workspacePath": "/workspace/admin",
                "ownerEmployeeId": "admin",
                "ownerAgentId": owner["id"],
                "taskGoal": "Keep one room",
            }
        )

        response = client.post(
            f"/api/v1/threads/{session['id']}/messages",
            json={
                "text": f"@{kimi['displayName']} what do you think?",
                "intent": "accomplish",
            },
        )

        assert response.status_code == 202
        commands = client.get(
            "/api/v1/daemon-nodes/node_admin/commands",
            headers={"Authorization": "Bearer node_token"},
        )
        assert commands.status_code == 200
        [command] = commands.json()["commands"]
        assert command["logicalAgentId"] == kimi["id"]


def test_mentioning_two_agents_dispatches_one_round_with_both(monkeypatch) -> None:
    monkeypatch.setenv("RELAY_ADMIN_TOKEN", "admin_token")
    with TemporaryDirectory() as root:
        app = create_app(root)
        client = TestClient(app)
        _bootstrap_admin(client)
        node = app.state.registry.register(
            {
                "sandboxId": "node_admin",
                "employeeId": "admin",
                "token": "node_token",
                "workspacePath": "/workspace/admin",
                "protocolVersion": 1,
                "supportedAgents": ["codex", "claude"],
                "capabilities": ["thread-workspaces"],
                "status": "ready",
            }
        )
        computer = computer_id(node)
        owner = app.state.agent_store.create_agent(
            "admin",
            {
                "displayName": "Codex",
                "executorKind": "codex",
                "defaultRole": "implementer",
                "computerId": computer,
            },
        )
        other = app.state.agent_store.create_agent(
            "admin",
            {
                "displayName": "Claude",
                "executorKind": "claude",
                "defaultRole": "implementer",
                "computerId": computer,
            },
        )
        sync_node_agents(app.state, node)
        session = app.state.session_store.create_session(
            {
                "daemonNodeId": node["id"],
                "workspacePath": "/workspace/admin",
                "ownerEmployeeId": "admin",
                "ownerAgentId": owner["id"],
                "taskGoal": "Keep one room",
            }
        )

        response = client.post(
            f"/api/v1/threads/{session['id']}/messages",
            json={
                "text": "both of you look at this",
                "intent": "accomplish",
                "addressAgentIds": [owner["id"], other["id"]],
            },
        )

        assert response.status_code == 202, response.text
        persisted = app.state.session_store.get_session(session["id"])
        manifest = persisted["collaborationRounds"][-1]
        assert {assignment["agentId"] for assignment in manifest["assignments"]} == {
            owner["id"],
            other["id"],
        }
        assert manifest["address"] == {
            "kind": "members",
            "agentIds": [owner["id"], other["id"]],
        }
        assert persisted["participantAgentIds"] == [owner["id"], other["id"]]


def test_message_retry_reconciles_participants_after_post_dispatch_failure(
    monkeypatch,
) -> None:
    monkeypatch.setenv("RELAY_ADMIN_TOKEN", "admin_token")
    with TemporaryDirectory() as root:
        app = create_app(root)
        client = TestClient(app)
        _bootstrap_admin(client)
        node = app.state.registry.register(
            {
                "sandboxId": "node_admin",
                "employeeId": "admin",
                "token": "node_token",
                "workspacePath": "/workspace/admin",
                "protocolVersion": 1,
                "supportedAgents": ["codex", "claude"],
                "capabilities": ["thread-workspaces"],
                "status": "ready",
            }
        )
        computer = computer_id(node)
        owner = app.state.agent_store.create_agent(
            "admin",
            {
                "displayName": "Codex",
                "executorKind": "codex",
                "defaultRole": "implementer",
                "computerId": computer,
            },
        )
        joiner = app.state.agent_store.create_agent(
            "admin",
            {
                "displayName": "Claude",
                "executorKind": "claude",
                "defaultRole": "implementer",
                "computerId": computer,
            },
        )
        sync_node_agents(app.state, node)
        session = app.state.session_store.create_session(
            {
                "daemonNodeId": node["id"],
                "workspacePath": "/workspace/admin",
                "ownerEmployeeId": "admin",
                "ownerAgentId": owner["id"],
                "taskGoal": "Keep one room",
            }
        )
        original = SessionController.record_participants_joined
        attempts = 0

        def fail_once(controller, session_id, agent_ids, actor_employee_id=None):
            nonlocal attempts
            attempts += 1
            if attempts == 1:
                raise ValueError("simulated participant admission interruption")
            return original(controller, session_id, agent_ids, actor_employee_id)

        monkeypatch.setattr(SessionController, "record_participants_joined", fail_once)
        body = {
            "text": "join this thread",
            "intent": "accomplish",
            "addressAgentIds": [owner["id"], joiner["id"]],
            "idempotencyKey": "message_admission_retry_1",
        }

        interrupted = client.post(
            f"/api/v1/threads/{session['id']}/messages", json=body
        )
        retried = client.post(f"/api/v1/threads/{session['id']}/messages", json=body)

        assert interrupted.status_code == 409
        assert retried.status_code == 202, retried.text
        persisted = app.state.session_store.get_session(session["id"])
        assert persisted["participantAgentIds"] == [owner["id"], joiner["id"]]
        assert len(app.state.daemon_store.take_queued_commands(node["id"])) == 1


def test_room_message_fans_out_to_every_participant(monkeypatch) -> None:
    monkeypatch.setenv("RELAY_ADMIN_TOKEN", "admin_token")
    with TemporaryDirectory() as root:
        app = create_app(root)
        client = TestClient(app)
        _bootstrap_admin(client)
        node = app.state.registry.register(
            {
                "sandboxId": "node_admin",
                "employeeId": "admin",
                "token": "node_token",
                "workspacePath": "/workspace/admin",
                "protocolVersion": 1,
                "supportedAgents": ["codex", "claude"],
                "capabilities": ["thread-workspaces"],
                "status": "ready",
            }
        )
        computer = computer_id(node)
        owner = app.state.agent_store.create_agent(
            "admin",
            {
                "displayName": "Codex",
                "executorKind": "codex",
                "defaultRole": "implementer",
                "computerId": computer,
            },
        )
        joiner = app.state.agent_store.create_agent(
            "admin",
            {
                "displayName": "Claude",
                "executorKind": "claude",
                "defaultRole": "implementer",
                "computerId": computer,
            },
        )
        sync_node_agents(app.state, node)
        session = app.state.session_store.create_session(
            {
                "daemonNodeId": node["id"],
                "workspacePath": "/workspace/admin",
                "ownerEmployeeId": "admin",
                "ownerAgentId": owner["id"],
                "taskGoal": "Keep one room",
            }
        )
        SessionController(app.state.session_store).record_participants_joined(
            session["id"], [joiner["id"]], "admin"
        )

        response = client.post(
            f"/api/v1/threads/{session['id']}/messages",
            json={"text": "status please", "intent": "accomplish"},
        )

        assert response.status_code == 202, response.text
        manifest = app.state.session_store.get_session(session["id"])[
            "collaborationRounds"
        ][-1]
        assert {assignment["agentId"] for assignment in manifest["assignments"]} == {
            owner["id"],
            joiner["id"],
        }


def test_mentioning_an_agent_from_another_computer_is_rejected(monkeypatch) -> None:
    monkeypatch.setenv("RELAY_ADMIN_TOKEN", "admin_token")
    with TemporaryDirectory() as root:
        app = create_app(root)
        client = TestClient(app)
        _bootstrap_admin(client)
        node = app.state.registry.register(
            {
                "sandboxId": "node_admin",
                "employeeId": "admin",
                "token": "node_token",
                "workspacePath": "/workspace/admin",
                "protocolVersion": 1,
                "supportedAgents": ["codex", "claude"],
                "capabilities": ["thread-workspaces"],
                "status": "ready",
            }
        )
        other_node = app.state.registry.register(
            {
                "sandboxId": "node_admin_2",
                "employeeId": "admin",
                "token": "node_token_2",
                "workspacePath": "/workspace/admin-2",
                "protocolVersion": 1,
                "supportedAgents": ["codex", "claude"],
                "capabilities": ["thread-workspaces"],
                "status": "ready",
            }
        )
        owner = app.state.agent_store.create_agent(
            "admin",
            {
                "displayName": "Codex",
                "executorKind": "codex",
                "defaultRole": "implementer",
                "computerId": computer_id(node),
            },
        )
        elsewhere = app.state.agent_store.create_agent(
            "admin",
            {
                "displayName": "Codex Elsewhere",
                "executorKind": "codex",
                "defaultRole": "implementer",
                "computerId": computer_id(other_node),
            },
        )
        sync_node_agents(app.state, node)
        sync_node_agents(app.state, other_node)
        session = app.state.session_store.create_session(
            {
                "daemonNodeId": node["id"],
                "workspacePath": "/workspace/admin",
                "ownerEmployeeId": "admin",
                "ownerAgentId": owner["id"],
                "taskGoal": "Keep one room",
            }
        )

        response = client.post(
            f"/api/v1/threads/{session['id']}/messages",
            json={
                "text": "come help",
                "intent": "accomplish",
                "addressAgentIds": [elsewhere["id"]],
            },
        )

        assert response.status_code == 400
        assert response.json()["detail"]["code"] == "agent_not_on_thread_node"


@pytest.mark.parametrize(
    "operation_fields",
    [{"idempotencyKey": "message_retry_1"}, {}],
)
def test_semantic_message_retry_reconciles_a_prepared_attempt_without_duplicate_events(
    monkeypatch, operation_fields
) -> None:
    monkeypatch.setenv("RELAY_ADMIN_TOKEN", "admin_token")
    with TemporaryDirectory() as root:
        app = create_app(root)
        client = TestClient(app)
        _bootstrap_admin(client)
        node = app.state.registry.register(
            {
                "sandboxId": "node_admin",
                "employeeId": "admin",
                "token": "node_token",
                "workspacePath": "/workspace/admin",
                "protocolVersion": 1,
                "supportedAgents": ["codex"],
                "capabilities": ["thread-workspaces"],
                "status": "ready",
            }
        )
        owner = app.state.agent_store.create_agent(
            "admin",
            {
                "displayName": "Codex",
                "executorKind": "codex",
                "defaultRole": "implementer",
                "computerId": computer_id(node),
            },
        )
        sync_node_agents(app.state, node)
        session = app.state.session_store.create_session(
            {
                "daemonNodeId": node["id"],
                "workspacePath": "/workspace/admin",
                "ownerEmployeeId": "admin",
                "ownerAgentId": owner["id"],
                "taskGoal": "Keep one room",
            }
        )
        original = SessionController.record_collaboration_round_started
        attempts = 0

        def fail_once(controller, session_id, manifest):
            nonlocal attempts
            attempts += 1
            if attempts == 1:
                prepared = app.state.registry.daemon_store.active_run_request_for_session_any_node(
                    session_id
                )
                assert prepared and prepared["status"] == "prepared"
                assert app.state.daemon_store.take_queued_commands(node["id"]) == []
                raise ValueError("simulated event-store interruption")
            return original(controller, session_id, manifest)

        monkeypatch.setattr(
            SessionController, "record_collaboration_round_started", fail_once
        )
        body = {
            "text": "continue safely",
            "intent": "accomplish",
            **operation_fields,
        }

        interrupted = client.post(
            f"/api/v1/threads/{session['id']}/messages", json=body
        )
        if operation_fields:
            prepared_id = app.state.daemon_store.list_active_run_requests()[0]["id"]
            monkeypatch.setattr(
                "relay.daemon_registry.registry.PREPARED_ADMISSION_LEASE_SECONDS", 0
            )
            app.state.registry.reap_stale_runs()
            assert app.state.daemon_store.get_run_request(prepared_id)["status"] == (
                "failed"
            )
        retried = client.post(f"/api/v1/threads/{session['id']}/messages", json=body)

        assert interrupted.status_code == 409
        assert retried.status_code == 202, retried.text
        persisted = app.state.session_store.get_session(session["id"])
        assert (
            len(
                [
                    event
                    for event in persisted["events"]
                    if event["type"] == "user.message"
                ]
            )
            == 1
        )
        assert (
            len(
                [
                    event
                    for event in persisted["events"]
                    if event["type"] == "collaboration.round.started"
                ]
            )
            == 1
        )
        assert len(app.state.daemon_store.take_queued_commands(node["id"])) == 1

        if operation_fields:
            conflict = client.post(
                f"/api/v1/threads/{session['id']}/messages",
                json={**body, "text": "a different operation"},
            )
            assert conflict.status_code == 409
            assert conflict.json()["detail"]["code"] == "idempotency_conflict"
        else:
            replay = client.post(f"/api/v1/threads/{session['id']}/messages", json=body)
            assert replay.status_code == 202, replay.text


def test_new_thread_retry_resumes_the_session_owned_by_its_prepared_admission(
    monkeypatch,
) -> None:
    monkeypatch.setenv("RELAY_ADMIN_TOKEN", "admin_token")
    with TemporaryDirectory() as root:
        app = create_app(root)
        client = TestClient(app)
        _bootstrap_admin(client)
        node = app.state.registry.register(
            {
                "sandboxId": "node_admin",
                "employeeId": "admin",
                "token": "node_token",
                "workspacePath": "/workspace/admin",
                "protocolVersion": 1,
                "supportedAgents": ["codex"],
                "capabilities": ["thread-workspaces"],
                "status": "ready",
            }
        )
        agent = app.state.agent_store.create_agent(
            "admin",
            {
                "displayName": "Codex",
                "executorKind": "codex",
                "defaultRole": "implementer",
                "computerId": computer_id(node),
            },
        )
        sync_node_agents(app.state, node)
        original = SessionController.record_collaboration_round_started
        attempts = 0

        def fail_once(controller, session_id, manifest):
            nonlocal attempts
            attempts += 1
            if attempts == 1:
                raise ValueError("simulated event-store interruption")
            return original(controller, session_id, manifest)

        monkeypatch.setattr(
            SessionController, "record_collaboration_round_started", fail_once
        )
        body = {
            "taskGoal": "start exactly once",
            "assignments": [{"agentId": agent["id"], "mode": "action"}],
            "idempotencyKey": "new_thread_retry_1",
        }

        interrupted = client.post("/api/v1/agent-runs", json=body)
        prepared = app.state.daemon_store.list_active_run_requests()[0]
        monkeypatch.setattr(
            "relay.daemon_registry.registry.PREPARED_ADMISSION_LEASE_SECONDS", 0
        )
        app.state.registry.reap_stale_runs()
        assert app.state.session_store.get_session(prepared["sessionId"])["status"] == (
            "failed"
        )
        retried = client.post("/api/v1/agent-runs", json=body)

        assert interrupted.status_code == 409
        assert retried.status_code == 202, retried.text
        assert retried.json()["id"] == prepared["sessionId"]
        assert retried.json()["status"] == "running"
        assert "finalOutcome" not in retried.json()
        assert len(app.state.daemon_store.take_queued_commands(node["id"])) == 1
        assert len(app.state.session_store.list_sessions()) == 1


def test_completed_thread_retry_reopens_after_message_commit_interruption(
    monkeypatch,
) -> None:
    monkeypatch.setenv("RELAY_ADMIN_TOKEN", "admin_token")
    with TemporaryDirectory() as root:
        app = create_app(root)
        client = TestClient(app)
        _bootstrap_admin(client)
        node = app.state.registry.register(
            {
                "sandboxId": "node_admin",
                "employeeId": "admin",
                "token": "node_token",
                "workspacePath": "/workspace/admin",
                "protocolVersion": 1,
                "supportedAgents": ["codex"],
                "capabilities": ["thread-workspaces"],
                "status": "ready",
            }
        )
        owner = app.state.agent_store.create_agent(
            "admin",
            {
                "displayName": "Codex",
                "executorKind": "codex",
                "defaultRole": "implementer",
                "computerId": computer_id(node),
            },
        )
        sync_node_agents(app.state, node)
        session = app.state.session_store.create_session(
            {
                "daemonNodeId": node["id"],
                "workspacePath": "/workspace/admin",
                "ownerEmployeeId": "admin",
                "ownerAgentId": owner["id"],
                "taskGoal": "finished once",
            }
        )
        SessionController(app.state.session_store).complete_session(
            session["id"], "first answer"
        )
        original = SessionController.continue_session
        attempts = 0

        def fail_once(controller, session_id):
            nonlocal attempts
            attempts += 1
            if attempts == 1:
                raise ValueError("simulated interruption after message commit")
            return original(controller, session_id)

        monkeypatch.setattr(SessionController, "continue_session", fail_once)
        body = {
            "text": "continue after completion",
            "intent": "accomplish",
            "userMessageId": "message_completed_retry_1",
        }

        interrupted = client.post(
            f"/api/v1/threads/{session['id']}/messages", json=body
        )
        retried = client.post(f"/api/v1/threads/{session['id']}/messages", json=body)

        assert interrupted.status_code == 409
        assert retried.status_code == 202, retried.text
        assert retried.json()["status"] == "running"
        assert "finalOutcome" not in retried.json()
        assert len(app.state.daemon_store.take_queued_commands(node["id"])) == 1
        assert (
            sum(event["type"] == "user.message" for event in retried.json()["events"])
            == 1
        )


def test_admin_can_replay_a_scoped_message_for_an_employee_owned_thread(
    monkeypatch,
) -> None:
    monkeypatch.setenv("RELAY_ADMIN_TOKEN", "admin_token")
    with TemporaryDirectory() as root:
        app = create_app(root)
        client = TestClient(app)
        _bootstrap_admin(client)
        assert (
            client.post(
                "/api/v1/admin/employees",
                json={
                    "employeeId": "alice",
                    "username": "alice",
                    "password": "userpass",
                },
            ).status_code
            == 201
        )
        node = app.state.registry.register(
            {
                "sandboxId": "node_alice",
                "employeeId": "alice",
                "token": "node_token",
                "workspacePath": "/workspace/alice",
                "protocolVersion": 1,
                "supportedAgents": ["codex"],
                "capabilities": ["thread-workspaces"],
                "status": "ready",
            }
        )
        agent = app.state.agent_store.create_agent(
            "alice",
            {
                "displayName": "Codex",
                "executorKind": "codex",
                "defaultRole": "implementer",
                "computerId": computer_id(node),
            },
        )
        sync_node_agents(app.state, node)
        session = app.state.session_store.create_session(
            {
                "daemonNodeId": node["id"],
                "workspacePath": "/workspace/alice",
                "ownerEmployeeId": "alice",
                "ownerAgentId": agent["id"],
                "taskGoal": "Admin-assisted room",
            }
        )
        body = {
            "text": "continue under supervision",
            "intent": "accomplish",
            "idempotencyKey": "admin_retry_1",
        }

        first = client.post(f"/api/v1/threads/{session['id']}/messages", json=body)
        replay = client.post(f"/api/v1/threads/{session['id']}/messages", json=body)

        assert first.status_code == 202
        assert replay.status_code == 202, replay.text
        assert replay.json()["id"] == session["id"]


def test_existing_thread_resumes_after_managed_runtime_replacement_without_read(
    monkeypatch,
) -> None:
    monkeypatch.setenv("RELAY_ADMIN_TOKEN", "admin_token")
    with TemporaryDirectory() as root:
        app = create_app(root)
        client = TestClient(app)
        _bootstrap_admin(client)
        managed = app.state.managed_node_store.create_node({"employeeId": "admin"})
        attempt, _credential = app.state.managed_node_store.create_attempt(
            managed["id"]
        )
        runtime, runtime_token = app.state.registry.enroll_managed_node(
            managed,
            attempt,
            {"workspacePath": "/workspace/admin"},
        )
        app.state.managed_node_store.complete_enrollment(
            managed["id"], attempt["id"], runtime["id"]
        )
        runtime = app.state.registry.register(
            {
                "sandboxId": runtime["id"],
                "token": runtime_token,
                "protocolVersion": 1,
                "supportedAgents": ["codex"],
                "capabilities": ["thread-workspaces"],
                "status": "ready",
            }
        )
        agent = app.state.agent_store.create_agent(
            "admin",
            {
                "displayName": "Codex",
                "executorKind": "codex",
                "defaultRole": "implementer",
                "computerId": f"managed:{managed['id']}",
            },
        )
        sync_node_agents(app.state, runtime)
        old_runtime_id = runtime["id"]
        session = app.state.session_store.create_session(
            {
                "daemonNodeId": old_runtime_id,
                "workspacePath": "/workspace/admin",
                "ownerEmployeeId": "admin",
                "ownerAgentId": agent["id"],
                "taskGoal": "Keep working",
            }
        )

        app.state.registry.delete(old_runtime_id)
        replacement_attempt, _credential = app.state.managed_node_store.create_attempt(
            managed["id"]
        )
        replacement, replacement_token = app.state.registry.enroll_managed_node(
            app.state.managed_node_store.get_node(managed["id"]),
            replacement_attempt,
            {"workspacePath": "/workspace/admin"},
        )
        app.state.managed_node_store.complete_enrollment(
            managed["id"], replacement_attempt["id"], replacement["id"]
        )
        replacement = app.state.registry.register(
            {
                "sandboxId": replacement["id"],
                "token": replacement_token,
                "protocolVersion": 1,
                "supportedAgents": ["codex"],
                "capabilities": ["thread-workspaces"],
                "status": "ready",
            }
        )
        sync_node_agents(app.state, replacement)
        [preserved_placement] = app.state.agent_placement_store.list_placements(
            agent_id=agent["id"]
        )
        assert preserved_placement["daemonNodeId"] == old_runtime_id
        assert preserved_placement["computerId"] == f"managed:{managed['id']}"
        listed_agent = next(
            item
            for item in client.get(
                "/api/v1/admin/agents?supervisorEmployeeId=admin"
            ).json()["agents"]
            if item["id"] == agent["id"]
        )
        [listed_placement] = listed_agent["placements"]
        assert listed_placement["status"] == "ready"
        assert listed_placement["daemonNodeId"] == old_runtime_id
        assert listed_placement["runtimeNodeId"] == replacement["id"]

        response = client.post(
            "/api/v1/agent-runs",
            json={
                "taskGoal": "Continue immediately",
                "sessionId": session["id"],
                "daemonNodeId": old_runtime_id,
                "assignments": [{"agentId": agent["id"]}],
            },
        )

        assert response.status_code == 202, response.text
        assert response.json()["managedNodeId"] == managed["id"]
        assert response.json()["agentRuns"][-1]["daemonNodeId"] == replacement["id"]
        persisted = app.state.session_store.get_session(session["id"])
        assert persisted["managedNodeId"] == managed["id"]
        assert any(
            event["type"] == "session.runtime_affinity" for event in persisted["events"]
        )


def test_existing_session_dispatch_normalizes_legacy_agent_supervisor(
    monkeypatch,
) -> None:
    monkeypatch.setenv("RELAY_ADMIN_TOKEN", "admin_token")
    with TemporaryDirectory() as root:
        app = create_app(root)
        client = TestClient(app)
        _bootstrap_admin(client)
        assert (
            client.post(
                "/api/v1/admin/employees",
                json={
                    "employeeId": "alice",
                    "username": "alice",
                    "password": "userpass",
                },
            ).status_code
            == 201
        )
        app.state.registry.register(
            {
                "sandboxId": "node_a",
                "employeeId": "alice",
                "token": "node_token",
                "workspacePath": "/workspace/alice",
                "protocolVersion": 1,
                "supportedAgents": ["codex"],
                "capabilities": ["thread-workspaces"],
                "status": "ready",
            }
        )
        agent = app.state.agent_store.create_agent(
            "alice",
            {
                "displayName": "Builder",
                "executorKind": "codex",
                "defaultRole": "implementer",
            },
        )
        placement = app.state.agent_placement_store.create_placement(agent, "node_a")
        legacy_agent = {**agent, "employeeId": "alice"}
        legacy_agent.pop("supervisorEmployeeId")
        legacy_placement = {**placement, "employeeId": "alice"}
        legacy_placement.pop("supervisorEmployeeId")
        _write_json(app.state.agent_store._snapshot_path(agent["id"]), legacy_agent)
        _write_json(
            app.state.agent_placement_store._snapshot_path(placement["id"]),
            legacy_placement,
        )
        session = app.state.session_store.create_session(
            {
                "workspacePath": "/workspace/alice",
                "ownerEmployeeId": "alice",
                "ownerAgentId": agent["id"],
                "taskGoal": "Build the feature",
            }
        )

        response = client.post(
            "/api/v1/agent-runs",
            json={
                "taskGoal": "Continue the feature",
                "sessionId": session["id"],
                "assignments": [{"agentId": agent["id"]}],
            },
        )

        assert response.status_code == 202, response.text


def test_logical_agent_handoff_records_the_target_agent_id(monkeypatch) -> None:
    monkeypatch.setenv("RELAY_ADMIN_TOKEN", "admin_token")
    with TemporaryDirectory() as root:
        app = create_app(root)
        client = TestClient(app)
        _bootstrap_admin(client)
        assert (
            client.post(
                "/api/v1/admin/employees",
                json={
                    "employeeId": "alice",
                    "username": "alice",
                    "password": "userpass",
                },
            ).status_code
            == 201
        )
        app.state.registry.register(
            {
                "sandboxId": "node_a",
                "employeeId": "alice",
                "token": "node_token",
                "workspacePath": "/workspace/alice",
                "protocolVersion": 1,
                "supportedAgents": ["codex"],
                "capabilities": ["thread-workspaces"],
                "status": "ready",
            }
        )
        builder = app.state.agent_store.create_agent(
            "alice",
            {
                "displayName": "Builder",
                "executorKind": "codex",
                "defaultRole": "implementer",
            },
        )
        reviewer = app.state.agent_store.create_agent(
            "alice",
            {
                "displayName": "Reviewer",
                "executorKind": "codex",
                "defaultRole": "implementer",
            },
        )
        for agent in (builder, reviewer):
            app.state.agent_placement_store.create_placement(agent, "node_a")
        session = app.state.session_store.create_session(
            {
                "workspacePath": "/workspace/alice",
                "ownerEmployeeId": "alice",
                "taskGoal": "Build the feature",
                "participants": ["human", "codex"],
            }
        )

        response = client.post(
            "/api/v1/agent-runs",
            json={
                "taskGoal": session["taskGoal"],
                "sessionId": session["id"],
                "assignments": [{"agentId": reviewer["id"]}],
                "decision": {"kind": "handoff", "targetAgent": "codex"},
            },
        )

        assert response.status_code == 202, response.text
        assert response.json()["decisions"][-1]["targetAgentId"] == reviewer["id"]


def test_employee_cannot_dispatch_a_team_across_shared_workspace_nodes(
    monkeypatch,
) -> None:
    monkeypatch.setenv("RELAY_ADMIN_TOKEN", "admin_token")
    with TemporaryDirectory() as root:
        app = create_app(root)
        client = TestClient(app)
        _bootstrap_admin(client)
        assert (
            client.post(
                "/api/v1/admin/employees",
                json={
                    "employeeId": "alice",
                    "username": "alice",
                    "password": "userpass",
                },
            ).status_code
            == 201
        )
        # Two distinct Computers (distinct machine ids) that happen to mount the
        # same shared workspace path. Sharing a workspaceId would make them one
        # Computer registered twice, and the later registration would retire the
        # earlier one.
        for node_id, executor in (("node_a", "claude"), ("node_b", "codex")):
            app.state.registry.register(
                {
                    "sandboxId": node_id,
                    "employeeId": "alice",
                    "token": f"token_{node_id}",
                    "workspacePath": "/workspace/shared",
                    "workspaceId": f"machine:alice:{node_id}",
                    "protocolVersion": 1,
                    "supportedAgents": [executor],
                    "capabilities": ["thread-workspaces"],
                    "maxConcurrentRuns": 2,
                    "status": "ready",
                }
            )
        planner = app.state.agent_store.create_agent(
            "alice",
            {
                "displayName": "Planner",
                "executorKind": "claude",
                "defaultRole": "implementer",
            },
        )
        builder = app.state.agent_store.create_agent(
            "alice",
            {
                "displayName": "Builder",
                "executorKind": "codex",
                "defaultRole": "implementer",
            },
        )
        for agent, node_id in ((planner, "node_a"), (builder, "node_b")):
            app.state.agent_placement_store.create_placement(
                agent,
                node_id,
                {"workspacePolicy": {"kind": "shared-path"}},
            )
        assert client.post("/api/v1/auth/logout").status_code == 200
        assert (
            client.post(
                "/api/v1/auth/login", json={"username": "alice", "password": "userpass"}
            ).status_code
            == 200
        )

        seeded = client.post(
            "/api/v1/agent-runs",
            json={
                "taskGoal": "Research the feature",
                "assignments": [{"agentId": planner["id"]}],
            },
        )
        assert seeded.status_code == 202, seeded.text

        response = client.post(
            "/api/v1/agent-runs",
            json={
                "taskGoal": "Plan and build the feature",
                "assignments": [
                    {"agentId": planner["id"]},
                    {"agentId": builder["id"]},
                ],
            },
        )

        assert response.status_code == 409, response.text
        assert response.json()["detail"]["code"] == "workspace_unavailable"


def test_new_thread_runs_on_the_selected_computer(monkeypatch) -> None:
    monkeypatch.setenv("RELAY_ADMIN_TOKEN", "admin_token")
    with TemporaryDirectory() as root:
        app = create_app(root)
        client = TestClient(app)
        _bootstrap_admin(client)
        assert (
            client.post(
                "/api/v1/admin/employees",
                json={
                    "employeeId": "alice",
                    "username": "alice",
                    "password": "userpass",
                },
            ).status_code
            == 201
        )
        for node_id in ("node_a", "node_b"):
            app.state.registry.register(
                {
                    "sandboxId": node_id,
                    "employeeId": "alice",
                    "token": f"token_{node_id}",
                    "workspacePath": f"/workspace/{node_id}",
                    "protocolVersion": 1,
                    "supportedAgents": ["codex"],
                    "capabilities": ["thread-workspaces"],
                    "status": "ready",
                }
            )
        builder = app.state.agent_store.create_agent(
            "alice",
            {
                "displayName": "Builder",
                "executorKind": "codex",
                "defaultRole": "implementer",
            },
        )
        app.state.agent_placement_store.create_placement(builder, "node_b")
        assert client.post("/api/v1/auth/logout").status_code == 200
        assert (
            client.post(
                "/api/v1/auth/login", json={"username": "alice", "password": "userpass"}
            ).status_code
            == 200
        )

        response = client.post(
            "/api/v1/agent-runs",
            json={
                "taskGoal": "Build on computer B",
                "daemonNodeId": "node_b",
                "assignments": [{"agentId": builder["id"]}],
            },
        )

        assert response.status_code == 202, response.text
        session = response.json()
        assert session["daemonNodeId"] == "node_b"
        created = next(
            event for event in session["events"] if event["type"] == "session.created"
        )
        assert created["daemonNodeId"] == "node_b"

        conflicting = client.post(
            "/api/v1/agent-runs",
            json={
                "taskGoal": "Try to move the existing thread",
                "sessionId": session["id"],
                "daemonNodeId": "node_a",
                "assignments": [{"agentId": builder["id"]}],
            },
        )

        assert conflicting.status_code == 409, conflicting.text
        assert conflicting.json()["detail"]["code"] == "workspace_unavailable"


def test_new_thread_rejects_an_agent_outside_the_selected_computer(
    monkeypatch,
) -> None:
    monkeypatch.setenv("RELAY_ADMIN_TOKEN", "admin_token")
    with TemporaryDirectory() as root:
        app = create_app(root)
        client = TestClient(app)
        _bootstrap_admin(client)
        assert (
            client.post(
                "/api/v1/admin/employees",
                json={
                    "employeeId": "alice",
                    "username": "alice",
                    "password": "userpass",
                },
            ).status_code
            == 201
        )
        for node_id in ("node_a", "node_b"):
            app.state.registry.register(
                {
                    "sandboxId": node_id,
                    "employeeId": "alice",
                    "token": f"token_{node_id}",
                    "workspacePath": f"/workspace/{node_id}",
                    "protocolVersion": 1,
                    "supportedAgents": ["codex"],
                    "capabilities": ["thread-workspaces"],
                    "status": "ready",
                }
            )
        builder = app.state.agent_store.create_agent(
            "alice",
            {
                "displayName": "Builder",
                "executorKind": "codex",
                "defaultRole": "implementer",
            },
        )
        app.state.agent_placement_store.create_placement(builder, "node_b")
        assert client.post("/api/v1/auth/logout").status_code == 200
        assert (
            client.post(
                "/api/v1/auth/login", json={"username": "alice", "password": "userpass"}
            ).status_code
            == 200
        )

        response = client.post(
            "/api/v1/agent-runs",
            json={
                "taskGoal": "Build on computer A",
                "daemonNodeId": "node_a",
                "assignments": [{"agentId": builder["id"]}],
            },
        )

        assert response.status_code == 409
        assert response.json()["detail"]["code"] == "workspace_unavailable"


def test_employee_cannot_list_or_dispatch_another_employees_agent(monkeypatch) -> None:
    monkeypatch.setenv("RELAY_ADMIN_TOKEN", "admin_token")
    with TemporaryDirectory() as root:
        app = create_app(root)
        client = TestClient(app)
        _bootstrap_admin(client)
        for employee_id in ("alice", "bob"):
            assert (
                client.post(
                    "/api/v1/admin/employees",
                    json={
                        "employeeId": employee_id,
                        "username": employee_id,
                        "password": "userpass",
                    },
                ).status_code
                == 201
            )
        node = app.state.registry.register(
            {
                "sandboxId": "shared_node",
                "employeeId": "alice",
                "token": "node_token",
                "workspacePath": "/workspace/shared",
                "protocolVersion": 1,
                "supportedAgents": ["codex"],
                "capabilities": ["thread-workspaces"],
                "status": "ready",
            }
        )
        agent = client.post(
            "/api/v1/admin/agents",
            json={
                "supervisorEmployeeId": "alice",
                "displayName": "Builder",
                "executorKind": "codex",
                "defaultRole": "implementer",
                "computerId": computer_id(node),
            },
        ).json()["agent"]
        _place_if_needed(client, agent["id"], "shared_node")

        assert client.post("/api/v1/auth/logout").status_code == 200
        assert (
            client.post(
                "/api/v1/auth/login", json={"username": "bob", "password": "userpass"}
            ).status_code
            == 200
        )
        assert client.get("/api/v1/agents").json()["agents"] == []

        denied = client.post(
            "/api/v1/agent-runs",
            json={
                "taskGoal": "Use Alice's agent",
                "assignments": [{"agentId": agent["id"]}],
            },
        )
        assert denied.status_code == 409
        assert denied.json()["detail"]["code"] == "agent_forbidden"


def test_legacy_sandbox_run_cannot_move_a_thread_to_another_computer(
    monkeypatch,
) -> None:
    monkeypatch.setenv("RELAY_ADMIN_TOKEN", "admin_token")
    with TemporaryDirectory() as root:
        app = create_app(root)
        client = TestClient(app)
        _bootstrap_admin(client)
        assert (
            client.post(
                "/api/v1/admin/employees",
                json={
                    "employeeId": "alice",
                    "username": "alice",
                    "password": "userpass",
                },
            ).status_code
            == 201
        )
        for node_id, machine_id in (("node_a", "machine-a"), ("node_b", "machine-b")):
            app.state.registry.register(
                {
                    "sandboxId": node_id,
                    "employeeId": "alice",
                    "token": f"token-{node_id}",
                    "workspaceId": machine_id,
                    "workspacePath": f"/workspace/{machine_id}",
                    "protocolVersion": 1,
                    "supportedAgents": ["codex"],
                    "capabilities": ["thread-workspaces"],
                    "status": "ready",
                }
            )
        session = app.state.session_store.create_session(
            {
                "workspacePath": "/workspace/machine-a",
                "taskGoal": "Continue here",
                "ownerEmployeeId": "alice",
                "daemonNodeId": "node_a",
                "computerId": "device:alice:machine-a",
            }
        )
        assert client.post("/api/v1/auth/logout").status_code == 200
        assert (
            client.post(
                "/api/v1/auth/login",
                json={"username": "alice", "password": "userpass"},
            ).status_code
            == 200
        )

        response = client.post(
            "/api/v1/sandboxes/node_b/runs",
            json={
                "sessionId": session["id"],
                "taskGoal": "Continue here",
                "assignments": [{"agent": "codex"}],
            },
        )

        assert response.status_code == 409
        assert "workspace_unavailable" in response.json()["detail"]


def test_legacy_run_reuses_compatibility_agent_after_device_reregistration(
    monkeypatch,
) -> None:
    monkeypatch.setenv("RELAY_ADMIN_TOKEN", "admin_token")
    with TemporaryDirectory() as root:
        app = create_app(root)
        client = TestClient(app)
        _bootstrap_admin(client)
        assert (
            client.post(
                "/api/v1/admin/employees",
                json={
                    "employeeId": "alice",
                    "username": "alice",
                    "password": "userpass",
                },
            ).status_code
            == 201
        )
        assert client.post("/api/v1/auth/logout").status_code == 200
        assert (
            client.post(
                "/api/v1/auth/login",
                json={"username": "alice", "password": "userpass"},
            ).status_code
            == 200
        )
        for node_id in ("node_old", "node_new"):
            app.state.registry.register(
                {
                    "sandboxId": node_id,
                    "employeeId": "alice",
                    "token": f"token-{node_id}",
                    "workspaceId": "machine-a",
                    "workspacePath": "/workspace/alice",
                    "protocolVersion": 1,
                    "supportedAgents": ["codex"],
                    "capabilities": ["thread-workspaces"],
                    "status": "ready",
                }
            )
            response = client.post(
                f"/api/v1/sandboxes/{node_id}/runs",
                json={
                    "taskGoal": f"Run on {node_id}",
                    "assignments": [{"agent": "codex"}],
                },
            )
            assert response.status_code == 202

        agents = client.get("/api/v1/agents").json()["agents"]
        assert len(agents) == 1
        assert agents[0]["compatibilityKey"] == "alice:device:alice:machine-a:codex"


def test_agent_stays_on_roster_when_its_computer_is_gone(
    monkeypatch,
) -> None:
    """Explicitly declared agents have no compatibilityKey, so the roster's
    old live-computer filter (`agent_routes.list_agents`) never applies to
    them — an agent whose computer is unassigned stays visible rather than
    dropping out. (The old compatibilityKey-gated drop no longer fires for
    any agent, since only the retired auto-creation path ever set that key.
    See test_binding_status_is_reported_over_the_wire_and_survives_computer_loss
    for the bindingStatus wire contract this roster behavior now carries.)"""
    monkeypatch.setenv("RELAY_ADMIN_TOKEN", "admin_token")
    with TemporaryDirectory() as root:
        app = create_app(root)
        client = TestClient(app)
        _bootstrap_admin(client)
        assert (
            client.post(
                "/api/v1/admin/employees",
                json={
                    "employeeId": "alice",
                    "username": "alice",
                    "password": "userpass",
                },
            ).status_code
            == 201
        )
        # A custom agent with no placement stays visible on the roster.
        client.post(
            "/api/v1/admin/agents",
            json={
                "supervisorEmployeeId": "alice",
                "displayName": "Freelancer",
                "executorKind": "claude",
                "defaultRole": "implementer",
                "computerId": _birth_computer_id(client, "alice", "claude"),
            },
        )
        node_a = app.state.registry.register(
            {
                "sandboxId": "node_a",
                "employeeId": "alice",
                "token": "node_token",
                "workspacePath": "/workspace/alice",
                "protocolVersion": 1,
                "supportedAgents": ["codex"],
                "capabilities": ["thread-workspaces"],
                "status": "ready",
            }
        )
        # Declaring the agent while its computer is already live auto-places it.
        declared = client.post(
            "/api/v1/admin/agents",
            json={
                "supervisorEmployeeId": "alice",
                "displayName": "Codex",
                "executorKind": "codex",
                "defaultRole": "implementer",
                "computerId": computer_id(node_a),
            },
        )
        assert declared.status_code == 201, declared.text

        assert client.post("/api/v1/auth/logout").status_code == 200
        assert (
            client.post(
                "/api/v1/auth/login", json={"username": "alice", "password": "userpass"}
            ).status_code
            == 200
        )

        before = client.get("/api/v1/agents").json()["agents"]
        names = {agent["displayName"] for agent in before}
        assert "Freelancer" in names
        assert "Codex" in names

        # Unassigning the computer retires the placement, but neither agent has
        # a compatibilityKey (explicit declaration never sets one), so both
        # stay on the roster.
        assert client.post("/api/v1/auth/logout").status_code == 200
        assert (
            client.post(
                "/api/v1/auth/login",
                json={"username": "admin", "password": "kestrel-vault-7719"},
            ).status_code
            == 200
        )
        assert (
            client.delete("/api/v1/admin/daemon-nodes/node_a/assignment").status_code
            == 200
        )
        assert client.post("/api/v1/auth/logout").status_code == 200
        assert (
            client.post(
                "/api/v1/auth/login", json={"username": "alice", "password": "userpass"}
            ).status_code
            == 200
        )

        after = client.get("/api/v1/agents").json()["agents"]
        assert {agent["displayName"] for agent in after} == {"Freelancer", "Codex"}


def test_agent_stays_on_roster_when_its_computer_is_deregistered(
    monkeypatch,
) -> None:
    """A placement left dangling at a node that vanished from the registry
    used to drop the agent from the roster, but only agents carrying a
    compatibilityKey were ever subject to that filter. Explicitly declared
    agents (the only kind created now) never get one, so the agent stays
    visible even with a dangling placement. (Deriving a real binding status
    for this case, instead of leaving the roster silent about it, is tracked
    separately.)"""
    monkeypatch.setenv("RELAY_ADMIN_TOKEN", "admin_token")
    with TemporaryDirectory() as root:
        app = create_app(root)
        client = TestClient(app)
        _bootstrap_admin(client)
        assert (
            client.post(
                "/api/v1/admin/employees",
                json={
                    "employeeId": "alice",
                    "username": "alice",
                    "password": "userpass",
                },
            ).status_code
            == 201
        )
        node_a = app.state.registry.register(
            {
                "sandboxId": "node_a",
                "employeeId": "alice",
                "token": "node_token",
                "workspacePath": "/workspace/alice",
                "protocolVersion": 1,
                "supportedAgents": ["codex"],
                "capabilities": ["thread-workspaces"],
                "status": "ready",
            }
        )
        # Declaring the agent while its computer is already live auto-places it.
        declared = client.post(
            "/api/v1/admin/agents",
            json={
                "supervisorEmployeeId": "alice",
                "displayName": "Codex",
                "executorKind": "codex",
                "defaultRole": "implementer",
                "computerId": computer_id(node_a),
            },
        )
        assert declared.status_code == 201, declared.text

        assert client.post("/api/v1/auth/logout").status_code == 200
        assert (
            client.post(
                "/api/v1/auth/login", json={"username": "alice", "password": "userpass"}
            ).status_code
            == 200
        )
        assert any(
            agent["displayName"] == "Codex"
            for agent in client.get("/api/v1/agents").json()["agents"]
        )

        # The computer vanishes from the registry (crash / re-enroll under a new
        # id) WITHOUT the placement being retired. The agent still has no
        # compatibilityKey, so the roster's live-computer filter never applies
        # to it and it stays visible despite the dangling placement.
        app.state.registry.delete("node_a")

        assert any(
            agent["displayName"] == "Codex"
            for agent in client.get("/api/v1/agents").json()["agents"]
        )


def test_task_persists_and_dispatches_a_logical_agent_assignment(monkeypatch) -> None:
    monkeypatch.setenv("RELAY_ADMIN_TOKEN", "admin_token")
    with TemporaryDirectory() as root:
        app = create_app(root)
        client = TestClient(app)
        _bootstrap_admin(client)
        assert (
            client.post(
                "/api/v1/admin/employees",
                json={
                    "employeeId": "alice",
                    "username": "alice",
                    "password": "userpass",
                },
            ).status_code
            == 201
        )
        app.state.registry.register(
            {
                "sandboxId": "node_a",
                "employeeId": "alice",
                "token": "node_token",
                "workspacePath": "/workspace/alice",
                "protocolVersion": 1,
                "supportedAgents": ["codex"],
                "capabilities": ["task-workspaces", "thread-workspaces"],
                "status": "ready",
            }
        )
        decoy_agent = client.post(
            "/api/v1/admin/agents",
            json={
                "supervisorEmployeeId": "alice",
                "displayName": "Earlier Builder",
                "executorKind": "codex",
                "defaultRole": "implementer",
                "computerId": "node:node_a",
            },
        ).json()["agent"]
        agent = client.post(
            "/api/v1/admin/agents",
            json={
                "supervisorEmployeeId": "alice",
                "displayName": "Selected Builder",
                "executorKind": "codex",
                "defaultRole": "implementer",
                "computerId": "node:node_a",
            },
        ).json()["agent"]
        _place_if_needed(client, decoy_agent["id"], "node_a")
        _place_if_needed(client, agent["id"], "node_a")
        assert client.post("/api/v1/auth/logout").status_code == 200
        assert (
            client.post(
                "/api/v1/auth/login", json={"username": "alice", "password": "userpass"}
            ).status_code
            == 200
        )

        task = client.post(
            "/api/v1/tasks", json={"title": "Build it", "assignedAgentId": agent["id"]}
        )
        started = client.post(
            f"/api/v1/tasks/{task.json()['id']}/runs",
            json={"assignments": [{"agentId": agent["id"]}]},
        )

        assert task.status_code == 201
        assert task.json()["assignedAgent"] == "codex"
        assert task.json()["assignedAgentId"] == agent["id"]
        assert started.status_code == 202
        assert (
            started.json()["session"]["agentRuns"][0]["logicalAgentId"] == agent["id"]
        )
        commands = client.get(
            "/api/v1/daemon-nodes/node_a/commands",
            headers={"Authorization": "Bearer node_token"},
        )
        assert commands.status_code == 200
        [command] = commands.json()["commands"]
        assert command["logicalAgentId"] == agent["id"]


def test_task_owner_cannot_be_reassigned_to_another_employees_agent(
    monkeypatch,
) -> None:
    monkeypatch.setenv("RELAY_ADMIN_TOKEN", "admin_token")
    with TemporaryDirectory() as root:
        client = TestClient(create_app(root))
        _bootstrap_admin(client)
        agents = {}
        for employee_id in ("alice", "bob"):
            assert (
                client.post(
                    "/api/v1/admin/employees",
                    json={
                        "employeeId": employee_id,
                        "username": employee_id,
                        "password": "userpass",
                    },
                ).status_code
                == 201
            )
            agents[employee_id] = client.post(
                "/api/v1/admin/agents",
                json={
                    "supervisorEmployeeId": employee_id,
                    "displayName": "Builder",
                    "executorKind": "codex",
                    "defaultRole": "implementer",
                    "computerId": _birth_computer_id(client, employee_id, "codex"),
                },
            ).json()["agent"]

        task = client.post(
            "/api/v1/tasks",
            json={
                "title": "Move ownership safely",
                "ownerEmployeeId": "alice",
                "assigneeEmployeeId": "alice",
                "assignedAgentId": agents["alice"]["id"],
            },
        ).json()

        missing_agent = client.patch(
            f"/api/v1/tasks/{task['id']}", json={"assigneeEmployeeId": "bob"}
        )
        assert missing_agent.status_code == 400

        reassigned = client.patch(
            f"/api/v1/tasks/{task['id']}",
            json={
                "assigneeEmployeeId": "bob",
                "assignedAgentId": agents["bob"]["id"],
            },
        )
        assert reassigned.status_code == 403


def test_employee_task_writes_require_named_agents_and_preserve_status(
    monkeypatch,
) -> None:
    monkeypatch.setenv("RELAY_ADMIN_TOKEN", "admin_token")
    with TemporaryDirectory() as root:
        client = TestClient(create_app(root))
        _bootstrap_admin(client)
        assert (
            client.post(
                "/api/v1/admin/employees",
                json={
                    "employeeId": "alice",
                    "username": "alice",
                    "password": "userpass",
                },
            ).status_code
            == 201
        )
        agent = client.post(
            "/api/v1/admin/agents",
            json={
                "supervisorEmployeeId": "alice",
                "displayName": "Builder",
                "executorKind": "codex",
                "defaultRole": "implementer",
                "computerId": _birth_computer_id(client, "alice", "codex"),
            },
        ).json()["agent"]
        assert client.post("/api/v1/auth/logout").status_code == 200
        assert (
            client.post(
                "/api/v1/auth/login", json={"username": "alice", "password": "userpass"}
            ).status_code
            == 200
        )

        legacy = client.post(
            "/api/v1/tasks",
            json={"title": "Legacy assignment", "assignedAgent": "codex"},
        )
        assert legacy.status_code == 400

        agentless_routine = client.post(
            "/api/v1/tasks",
            json={
                "title": "Unsafe routine",
                "isRoutine": True,
                "routineEnabled": True,
            },
        )
        assert agentless_routine.status_code == 400

        created = client.post(
            "/api/v1/tasks",
            json={
                "title": "Explicitly blocked",
                "status": "blocked",
                "assignedAgentId": agent["id"],
            },
        )
        assert created.status_code == 201
        assert created.json()["status"] == "blocked"
        assert created.json()["assigneeEmployeeId"] == "alice"

        cleared = client.patch(
            f"/api/v1/tasks/{created.json()['id']}", json={"assignedAgentId": None}
        )
        assert cleared.status_code == 200
        assert cleared.json()["status"] == "blocked"
        assert "assignedAgent" not in cleared.json()
        assert "assignedAgentId" not in cleared.json()


def test_manual_start_materializes_a_legacy_task_assignment(monkeypatch) -> None:
    """A legacy `assignedAgent` runtime task resolves to an already-declared
    agent for that runtime/computer pair on manual start; nothing is
    auto-created."""
    monkeypatch.setenv("RELAY_ADMIN_TOKEN", "admin_token")
    with TemporaryDirectory() as root:
        app = create_app(root)
        client = TestClient(app)
        _bootstrap_admin(client)
        assert (
            client.post(
                "/api/v1/admin/employees",
                json={
                    "employeeId": "alice",
                    "username": "alice",
                    "password": "userpass",
                },
            ).status_code
            == 201
        )
        node = app.state.registry.register(
            {
                "sandboxId": "node_a",
                "employeeId": "alice",
                "token": "node_token",
                "workspacePath": "/workspace/alice",
                "protocolVersion": 1,
                "supportedAgents": ["codex"],
                "capabilities": ["task-workspaces", "thread-workspaces"],
                "status": "ready",
            }
        )
        declared = app.state.agent_store.create_agent(
            "alice",
            {
                "displayName": "Codex",
                "executorKind": "codex",
                "defaultRole": "implementer",
                "computerId": computer_id(node),
            },
        )
        legacy = app.state.task_store.create_task(
            {
                "title": "Start legacy work",
                "ownerEmployeeId": "requester",
                "assigneeEmployeeId": "alice",
                "assignedAgent": "codex",
                "status": "assigned",
            }
        )
        assert client.post("/api/v1/auth/logout").status_code == 200
        assert (
            client.post(
                "/api/v1/auth/login", json={"username": "alice", "password": "userpass"}
            ).status_code
            == 200
        )

        started = client.post(f"/api/v1/tasks/{legacy['id']}/runs", json={})

        assert started.status_code == 202
        updated = app.state.task_store.get_task(legacy["id"])
        assert updated["assignedAgentId"] == declared["id"]
        assert (
            started.json()["session"]["agentRuns"][0]["logicalAgentId"]
            == declared["id"]
        )


def test_failed_agent_first_run_finalizes_instead_of_wedging(monkeypatch) -> None:
    """A non-zero exit on an agent-first run must reach a terminal state.

    Agent-first assignments carry agentId/executorKind and no "agent" key, so
    the failure branch used to raise while finalizing. The request stayed
    `finalizing` forever, re-raising on every reap pass — and because reaping
    runs inside monitor_nodes(), that took most of the API down with it.
    """
    monkeypatch.setenv("RELAY_ADMIN_TOKEN", "admin_token")
    with TemporaryDirectory() as root:
        app = create_app(root)
        client = TestClient(app)
        _bootstrap_admin(client)
        assert (
            client.post(
                "/api/v1/admin/employees",
                json={
                    "employeeId": "alice",
                    "username": "alice",
                    "password": "userpass",
                },
            ).status_code
            == 201
        )
        app.state.registry.register(
            {
                "sandboxId": "node_a",
                "employeeId": "alice",
                "token": "node_token",
                "workspacePath": "/workspace/alice",
                "protocolVersion": 1,
                "supportedAgents": ["codex"],
                "capabilities": ["thread-workspaces"],
                "status": "ready",
            }
        )
        agent = client.post(
            "/api/v1/admin/agents",
            json={
                "supervisorEmployeeId": "alice",
                "displayName": "Elon Musk",
                "executorKind": "codex",
                "defaultRole": "implementer",
                "computerId": "node:node_a",
            },
        ).json()["agent"]
        _place_if_needed(client, agent["id"], "node_a")

        run = client.post(
            "/api/v1/agent-runs",
            json={
                "taskGoal": "Build the feature",
                "assignments": [{"agentId": agent["id"]}],
            },
        )
        assert run.status_code == 202
        session_id = run.json()["id"]
        [command] = client.get(
            "/api/v1/daemon-nodes/node_a/commands?leaseMode=explicit&leaseSeconds=10",
            headers={"Authorization": "Bearer node_token"},
        ).json()["commands"]

        completed = client.post(
            "/api/v1/daemon-nodes/node_a/events",
            json={
                "type": "run.completed",
                "commandId": command["id"],
                "leaseId": command["leaseId"],
                "sessionId": session_id,
                "runId": command["runId"],
                "agent": command["agent"],
                "exitCode": 1,
                "agentLog": "boom",
            },
            headers={"Authorization": "Bearer node_token"},
        )
        assert completed.status_code == 200

        # monitor_nodes() drives the reaper; it must not raise, and the request
        # must not be left active.
        app.state.registry.monitor_nodes()
        active = [
            request
            for request in app.state.registry.daemon_store.list_active_run_requests()
            if request["sessionId"] == session_id
        ]
        assert active == []
        assert client.get(f"/api/v1/threads/{session_id}").json()["status"] == "failed"


def test_agent_role_is_visible_but_not_patchable(monkeypatch) -> None:
    """defaultRole is part of the birth certificate: it decides what an agent
    is for, so changing it is indistinguishable from swapping in a different
    colleague. It has to be readable everywhere the agent is rendered, but
    neither the admin route nor the employee's own route may PATCH it —
    both reach the same store-level rejection.
    """
    monkeypatch.setenv("RELAY_ADMIN_TOKEN", "admin_token")
    with TemporaryDirectory() as root:
        client = TestClient(create_app(root))
        _bootstrap_admin(client)
        assert (
            client.post(
                "/api/v1/admin/employees",
                json={
                    "employeeId": "alice",
                    "username": "alice",
                    "password": "userpass",
                    "displayName": "Alice",
                },
            ).status_code
            == 201
        )
        agent = client.post(
            "/api/v1/admin/agents",
            json={
                "supervisorEmployeeId": "alice",
                "displayName": "Reviewer",
                "executorKind": "claude",
                "defaultRole": "reviewer",
                "computerId": _birth_computer_id(client, "alice", "claude"),
            },
        ).json()["agent"]

        # The role decides what a team member is told to do, so the view that
        # renders the agent has to carry it.
        listed = client.get("/api/v1/admin/agents").json()["agents"]
        assert (
            next(item for item in listed if item["id"] == agent["id"])["defaultRole"]
            == "reviewer"
        )

        # defaultRole is no longer a patchable field at all: clearing it and
        # setting an invalid value both fail the same way, as an unsupported
        # field rather than an invalid enum value.
        cleared = client.patch(
            f"/api/v1/admin/agents/{agent['id']}", json={"defaultRole": None}
        )
        assert cleared.status_code == 400
        assert "defaultRole" in cleared.text

        invalid = client.patch(
            f"/api/v1/admin/agents/{agent['id']}", json={"defaultRole": "wizard"}
        )
        assert invalid.status_code == 400
        assert "defaultRole" in invalid.text

        # The supervisor's own route rejects it identically — the role isn't
        # personality, so it doesn't belong on the picker the supervisor uses
        # to tune their agent.
        assert client.post("/api/v1/auth/logout").status_code == 200
        assert (
            client.post(
                "/api/v1/auth/login",
                json={"username": "alice", "password": "userpass"},
            ).status_code
            == 200
        )
        owned = client.patch(
            f"/api/v1/agents/{agent['id']}", json={"defaultRole": "planner"}
        )
        assert owned.status_code == 400
        assert "defaultRole" in owned.text

        # The role itself is untouched by the rejected attempts.
        still_alice = client.get("/api/v1/agents").json()["agents"]
        assert (
            next(item for item in still_alice if item["id"] == agent["id"])[
                "defaultRole"
            ]
            == "reviewer"
        )


def test_employee_creates_an_agent_on_their_own_computer(client_with_node) -> None:
    client, node = client_with_node  # follows this file's existing fixture pattern
    response = client.post(
        "/api/v1/agents",
        json={
            "computerId": node["computerId"],
            "executorKind": "claude",
            "defaultRole": "implementer",
            "displayName": "Ada",
        },
    )
    assert response.status_code == 201
    agent = response.json()["agent"]
    assert agent["computerId"] == node["computerId"]
    assert agent["defaultRole"] == "implementer"


def test_agent_list_normalizes_a_legacy_placement_to_its_stable_computer(
    client_with_node,
) -> None:
    client, node = client_with_node
    agent = client.post(
        "/api/v1/agents",
        json={
            "computerId": node["computerId"],
            "executorKind": "claude",
            "defaultRole": "implementer",
            "displayName": "Legacy Ada",
        },
    ).json()["agent"]
    [placement] = client.app.state.agent_placement_store.list_placements(
        agent_id=agent["id"]
    )
    legacy = {**placement}
    legacy.pop("computerId")
    _write_json(
        client.app.state.agent_placement_store._snapshot_path(placement["id"]),
        legacy,
    )

    listed = client.get("/api/v1/agents").json()["agents"]
    [placement_view] = next(
        item for item in listed if item["id"] == agent["id"]
    )["placements"]

    assert placement_view["computerId"] == node["computerId"]


def test_creation_rejects_a_runtime_the_computer_does_not_have(
    client_with_node,
) -> None:
    client, node = client_with_node
    response = client.post(
        "/api/v1/agents",
        json={
            "computerId": node["computerId"],
            "executorKind": "kimi",  # this node only reports claude
            "defaultRole": "implementer",
        },
    )
    assert response.status_code == 400
    assert "runtime" in response.json()["detail"].lower()


def test_creation_rejects_another_employees_computer(client_with_node) -> None:
    client, _ = client_with_node
    response = client.post(
        "/api/v1/agents",
        json={
            "computerId": "device:bob:machine-z",
            "executorKind": "claude",
            "defaultRole": "implementer",
        },
    )
    assert response.status_code == 404


def test_creation_rejects_an_unknown_role(client_with_node) -> None:
    client, node = client_with_node
    response = client.post(
        "/api/v1/agents",
        json={
            "computerId": node["computerId"],
            "executorKind": "claude",
            "defaultRole": "chief-of-staff",
        },
    )
    assert response.status_code == 400


def test_creation_is_allowed_while_the_computer_is_offline(
    client_with_offline_node,
) -> None:
    """An employee can create an agent for a computer that's currently offline; sync backfills the placement once it comes online."""
    client, node = client_with_offline_node
    response = client.post(
        "/api/v1/agents",
        json={
            "computerId": node["computerId"],
            "executorKind": "claude",
            "defaultRole": "implementer",
        },
    )
    assert response.status_code == 201


def test_role_cannot_be_patched_after_creation(client_with_node) -> None:
    client, node = client_with_node
    agent = client.post(
        "/api/v1/agents",
        json={
            "computerId": node["computerId"],
            "executorKind": "claude",
            "defaultRole": "implementer",
        },
    ).json()["agent"]
    response = client.patch(
        f"/api/v1/agents/{agent['id']}", json={"defaultRole": "reviewer"}
    )
    assert response.status_code == 400


def test_creation_does_not_place_on_an_online_node_that_lacks_the_runtime(
    monkeypatch,
) -> None:
    """A computer can be made up of several node records (re-provisioning
    swaps in a new node id, and the stale record doesn't disappear on its
    own). available_runtimes() unions ready runtimes across all of a
    computer's nodes, so creation can succeed even though no single online
    node is ready for the requested runtime. Placement must not be forced
    onto some other online node just because it happens to be online — that
    would leave the agent permanently rejected by the daemon's dispatch
    admission check, which only trusts the node it was actually placed on.
    """
    monkeypatch.setenv("RELAY_ADMIN_TOKEN", "admin_token")
    with TemporaryDirectory() as root:
        app = create_app(root)
        client = TestClient(app)
        _bootstrap_admin(client)
        assert (
            client.post(
                "/api/v1/admin/employees",
                json={
                    "employeeId": "alice",
                    "username": "alice",
                    "password": "userpass",
                    "displayName": "Alice",
                },
            ).status_code
            == 201
        )

        # An old, offline node record still reporting claude as ready — the
        # kind of record left behind when the machine was re-provisioned.
        offline_node = app.state.registry.register(
            {
                "sandboxId": "multi_node_offline",
                "employeeId": "alice",
                "workspaceId": "machine-multi",
                "token": "node_token",
                "workspacePath": "/workspace/alice",
                "protocolVersion": 1,
                "supportedAgents": ["claude"],
                "capabilities": ["thread-workspaces"],
                "status": "stopped",
            }
        )
        # The current, online node record for the same machine — only ready
        # for codex.
        online_node = app.state.registry.register(
            {
                "sandboxId": "multi_node_online",
                "employeeId": "alice",
                "workspaceId": "machine-multi",
                "token": "node_token",
                "workspacePath": "/workspace/alice",
                "protocolVersion": 1,
                "supportedAgents": ["codex"],
                "capabilities": ["thread-workspaces"],
                "status": "ready",
            }
        )
        assert computer_id(offline_node) == computer_id(online_node)

        assert (
            client.post(
                "/api/v1/auth/login",
                json={"username": "alice", "password": "userpass"},
            ).status_code
            == 200
        )
        response = client.post(
            "/api/v1/agents",
            json={
                "computerId": computer_id(online_node),
                "executorKind": "claude",
                "defaultRole": "implementer",
            },
        )
        assert response.status_code == 201, response.text
        agent = response.json()["agent"]

        placements = app.state.agent_placement_store.list_placements(
            agent_id=agent["id"]
        )
        assert placements == [], (
            "must not place claude on a node that only reports codex ready"
        )


def test_creation_rejects_a_real_computer_belonging_to_another_employee(
    monkeypatch,
) -> None:
    """A previous version of this check only proved that an unknown
    computerId 404s. That leaves the actual employee-ownership boundary
    unverified: it says nothing about whether a computer bob genuinely owns
    is rejected when alice tries to create an agent on it.
    """
    monkeypatch.setenv("RELAY_ADMIN_TOKEN", "admin_token")
    with TemporaryDirectory() as root:
        app = create_app(root)
        client = TestClient(app)
        _bootstrap_admin(client)
        for employee_id in ("alice", "bob"):
            assert (
                client.post(
                    "/api/v1/admin/employees",
                    json={
                        "employeeId": employee_id,
                        "username": employee_id,
                        "password": "userpass",
                        "displayName": employee_id.title(),
                    },
                ).status_code
                == 201
            )

        bob_node = app.state.registry.register(
            {
                "sandboxId": "node_bob",
                "employeeId": "bob",
                "workspaceId": "machine-bob",
                "token": "node_token",
                "workspacePath": "/workspace/bob",
                "protocolVersion": 1,
                "supportedAgents": ["claude"],
                "capabilities": ["thread-workspaces"],
                "status": "ready",
            }
        )

        assert (
            client.post(
                "/api/v1/auth/login",
                json={"username": "alice", "password": "userpass"},
            ).status_code
            == 200
        )
        response = client.post(
            "/api/v1/agents",
            json={
                "computerId": computer_id(bob_node),
                "executorKind": "claude",
                "defaultRole": "implementer",
            },
        )
        assert response.status_code == 404


def test_binding_status_is_reported_over_the_wire_and_survives_computer_loss(
    client_with_node,
) -> None:
    """bindingStatus is this branch's headline user-visible field, but until
    now nothing asserted it actually reaches an HTTP response body (only the
    pure binding_status() function was unit-tested). This also doubles as
    the roster-retention check: the agent must stay listed, with its status
    flipped to computer_gone, once its computer disappears from the registry.
    """
    client, node = client_with_node
    created = client.post(
        "/api/v1/agents",
        json={
            "computerId": node["computerId"],
            "executorKind": "claude",
            "defaultRole": "implementer",
            "displayName": "Ada",
        },
    )
    assert created.status_code == 201, created.text
    agent_id = created.json()["agent"]["id"]

    before = client.get("/api/v1/agents").json()["agents"]
    before_by_id = {agent["id"]: agent for agent in before}
    assert before_by_id[agent_id]["bindingStatus"] == "available"

    # The computer disappears from the registry entirely (crash / re-enroll
    # under a new id) rather than merely going offline.
    client.app.state.registry.delete(node["id"])

    after = client.get("/api/v1/agents").json()["agents"]
    after_by_id = {agent["id"]: agent for agent in after}
    assert agent_id in after_by_id, "agent must stay on the roster once its computer is gone"
    assert after_by_id[agent_id]["bindingStatus"] == "computer_gone"


def test_agent_view_lists_skills_installed_for_its_runtime(monkeypatch) -> None:
    """Skills are node-reported, so an agent shows only the ones installed for
    its own runtime on the computer it is placed on."""
    monkeypatch.setenv("RELAY_ADMIN_TOKEN", "admin_token")
    with TemporaryDirectory() as root:
        app = create_app(root)
        client = TestClient(app)
        _bootstrap_admin(client)
        assert (
            client.post(
                "/api/v1/admin/employees",
                json={
                    "employeeId": "alice",
                    "username": "alice",
                    "password": "userpass",
                    "displayName": "Alice",
                },
            ).status_code
            == 201
        )
        node = app.state.registry.register(
            {
                "sandboxId": "node_alice",
                "employeeId": "alice",
                "workspaceId": "machine-alice",
                "token": "node_token",
                "workspacePath": "/workspace/alice",
                "nodeLocation": "employee-device",
                "protocolVersion": 1,
                "supportedAgents": ["claude", "codex"],
                "capabilities": ["thread-workspaces"],
                "status": "ready",
                "agentInventory": {
                    "claude": {
                        "skills": [
                            {
                                "name": "brainstorming",
                                "namespace": "superpowers",
                                "description": "Ideas.",
                            },
                            {"name": "tdd"},
                        ],
                        "mcpServers": [],
                    },
                    "codex": {"skills": [{"name": "rescue"}], "mcpServers": []},
                },
            }
        )
        created = client.post(
            "/api/v1/admin/agents",
            json={
                "supervisorEmployeeId": "alice",
                "displayName": "Researcher",
                "executorKind": "claude",
                "defaultRole": "planner",
                "computerId": computer_id(node),
            },
        )
        assert created.status_code == 201, created.text
        agent_id = created.json()["agent"]["id"]
        _place_if_needed(client, agent_id, "node_alice")

        assert client.post("/api/v1/auth/logout").status_code == 200
        assert (
            client.post(
                "/api/v1/auth/login", json={"username": "alice", "password": "userpass"}
            ).status_code
            == 200
        )
        response = client.get("/api/v1/agents")

        assert response.status_code == 200, response.text
        agent = next(
            item for item in response.json()["agents"] if item["id"] == agent_id
        )
        assert agent["skills"] == [
            {"name": "tdd"},
            {
                "name": "brainstorming",
                "namespace": "superpowers",
                "description": "Ideas.",
            },
        ]


def test_agent_without_placement_reports_no_skills(monkeypatch) -> None:
    monkeypatch.setenv("RELAY_ADMIN_TOKEN", "admin_token")
    with TemporaryDirectory() as root:
        app = create_app(root)
        client = TestClient(app)
        _bootstrap_admin(client)
        assert (
            client.post(
                "/api/v1/admin/employees",
                json={
                    "employeeId": "alice",
                    "username": "alice",
                    "password": "userpass",
                    "displayName": "Alice",
                },
            ).status_code
            == 201
        )
        computer = _birth_computer_id(client, "alice", "claude")
        created = client.post(
            "/api/v1/admin/agents",
            json={
                "supervisorEmployeeId": "alice",
                "displayName": "Researcher",
                "executorKind": "claude",
                "defaultRole": "planner",
                "computerId": computer,
            },
        )
        assert created.status_code == 201, created.text

        assert client.post("/api/v1/auth/logout").status_code == 200
        assert (
            client.post(
                "/api/v1/auth/login", json={"username": "alice", "password": "userpass"}
            ).status_code
            == 200
        )
        response = client.get("/api/v1/agents")

        assert response.status_code == 200, response.text
        assert response.json()["agents"][0]["skills"] == []
