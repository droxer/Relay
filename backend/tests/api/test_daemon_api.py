from __future__ import annotations

import asyncio
import json
import time
from tempfile import TemporaryDirectory
from typing import Any
from uuid import UUID

from fastapi.testclient import TestClient
from relay.app import create_app
from relay.core.computer_identity import computer_id
from relay.persistence.agent_placement_store import LocalAgentPlacementStore
from relay.services.agent_routing import placement_node
from relay.services.node_agents import sync_node_agents
from relay.sessions.controller import SessionController


def _bootstrap_admin(client: TestClient) -> None:
    response = client.post(
        "/api/v1/auth/bootstrap",
        json={
            "token": "admin_token",
            "username": "admin",
            "password": "kestrel-vault-7719",
        },
    )
    assert response.status_code == 200


def _login_admin(client: TestClient) -> None:
    response = client.post(
        "/api/v1/auth/login",
        json={
            "username": "admin",
            "password": "kestrel-vault-7719",
        },
    )
    assert response.status_code == 200


def _login(client: TestClient, username: str, password: str) -> None:
    response = client.post(
        "/api/v1/auth/login",
        json={
            "username": username,
            "password": password,
        },
    )
    assert response.status_code == 200


def _create_user(client: TestClient, username: str, *, employee_id: str) -> None:
    response = client.post(
        "/api/v1/admin/users",
        json={
            "username": username,
            "password": "userpass",
            "role": "user",
            "employeeId": employee_id,
        },
    )
    assert response.status_code == 201


def test_daemon_run_events_leave_the_async_event_loop(monkeypatch) -> None:
    monkeypatch.setenv("RELAY_ADMIN_TOKEN", "admin_token")
    with TemporaryDirectory() as root:
        app = create_app(root)
        client = TestClient(app)
        ran_on_event_loop: list[bool] = []

        def handle_event(*_args: object) -> None:
            try:
                asyncio.get_running_loop()
            except RuntimeError:
                ran_on_event_loop.append(False)
            else:
                ran_on_event_loop.append(True)

        monkeypatch.setattr(app.state.registry, "handle_event", handle_event)
        response = client.post(
            "/api/v1/daemon-nodes/sbx_test/events",
            json={
                "type": "run.output",
                "commandId": "cmd_1",
                "sessionId": "ses_1",
                "runId": "run_1",
                "agent": "codex",
                "stream": "stdout",
                "text": "live",
                "sequence": 0,
            },
            headers={"Authorization": "Bearer node_token"},
        )

        assert response.status_code == 200
        assert ran_on_event_loop == [False]


def test_daemon_output_batch_preserves_order(monkeypatch) -> None:
    monkeypatch.setenv("RELAY_ADMIN_TOKEN", "admin_token")
    with TemporaryDirectory() as root:
        app = create_app(root)
        client = TestClient(app)
        handled: list[dict[str, Any]] = []
        monkeypatch.setattr(
            app.state.registry,
            "handle_event",
            lambda _sandbox_id, event, _token: handled.append(event),
        )

        response = client.post(
            "/api/v1/daemon-nodes/sbx_test/events",
            json={
                "type": "run.output.batch",
                "commandId": "cmd_1",
                "sessionId": "ses_1",
                "runId": "run_1",
                "agent": "codex",
                "entries": [
                    {"stream": "stdout", "text": "out-1", "sequence": 0},
                    {"stream": "stderr", "text": "err-1", "sequence": 1},
                    {"stream": "stdout", "text": "out-2", "sequence": 2},
                ],
            },
            headers={"Authorization": "Bearer node_token"},
        )

        assert response.status_code == 200
        assert handled[0]["type"] == "run.output.batch"
        assert [entry["stream"] for entry in handled[0]["entries"]] == [
            "stdout",
            "stderr",
            "stdout",
        ]


def test_workspace_event_is_authorized_and_resolves_query_broker(monkeypatch) -> None:
    monkeypatch.setenv("RELAY_ADMIN_TOKEN", "admin_token")
    with TemporaryDirectory() as root:
        app = create_app(root)
        client = TestClient(app)
        app.state.registry.register(
            {
                "sandboxId": "sbx_workspace",
                "employeeId": "alice",
                "token": "node_token",
                "protocolVersion": 1,
                "supportedAgents": ["codex"],
                "capabilities": ["thread-workspaces"],
                "status": "ready",
            }
        )
        received: list[tuple[str, str, dict]] = []

        class Broker:
            def resolve(self, command_id, sandbox_id, payload):
                received.append((command_id, sandbox_id, payload))
                return True

        app.state.workspace_query_broker = Broker()
        event = {
            "type": "workspace.listing",
            "commandId": "00000000-0000-4000-8000-000000000080",
            "agentId": "agent_1",
            "path": "",
            "exists": True,
            "entries": [],
        }
        app.state.daemon_store.enqueue_command(
            "sbx_workspace",
            {
                "id": event["commandId"],
                "type": "workspace.list",
                "path": "",
            },
        )
        app.state.daemon_store.take_queued_commands("sbx_workspace")
        response = client.post(
            "/api/v1/daemon-nodes/sbx_workspace/events",
            json=event,
            headers={"Authorization": "Bearer node_token"},
        )
        assert response.status_code == 200
        assert received == [
            ("00000000-0000-4000-8000-000000000080", "sbx_workspace", event)
        ]
        assert (
            client.post(
                "/api/v1/daemon-nodes/sbx_workspace/events",
                json=event,
                headers={"Authorization": "Bearer wrong"},
            ).status_code
            == 401
        )


def test_daemon_heartbeat_is_authenticated_and_returns_lease_policy(
    monkeypatch,
) -> None:
    monkeypatch.setenv("RELAY_ADMIN_TOKEN", "admin_token")
    with TemporaryDirectory() as root:
        app = create_app(root)
        client = TestClient(app)
        app.state.registry.register(
            {
                "sandboxId": "sbx_heartbeat",
                "employeeId": "alice",
                "token": "node_token",
                "protocolVersion": 1,
                "supportedAgents": ["codex"],
                "capabilities": ["thread-workspaces"],
                "status": "ready",
            }
        )

        response = client.post(
            "/api/v1/daemon-nodes/sbx_heartbeat/heartbeat",
            json={"activeCommandLeases": []},
            headers={"Authorization": "Bearer node_token"},
        )

        assert response.status_code == 200
        heartbeat = response.json()["heartbeat"]
        assert heartbeat["intervalMs"] == 5_000
        assert heartbeat["timeoutMs"] == 15_000
        assert heartbeat["observedAt"]
        assert (
            client.post(
                "/api/v1/daemon-nodes/sbx_heartbeat/heartbeat",
                json={},
                headers={"Authorization": "Bearer wrong"},
            ).status_code
            == 401
        )


def test_managed_node_provisioning_replays_the_same_runtime_after_lost_response(
    monkeypatch,
) -> None:
    monkeypatch.setenv("RELAY_ADMIN_TOKEN", "admin_token")
    with TemporaryDirectory() as root:
        app = create_app(root)
        client = TestClient(app)
        _bootstrap_admin(client)
        _login_admin(client)
        _create_user(client, "alice", employee_id="alice")

        rejected_local = client.post(
            "/api/v1/admin/managed-nodes",
            json={
                "employeeId": "alice",
                "provider": "local-process",
                "sandboxMode": "none",
            },
        )
        assert rejected_local.status_code == 409
        assert "require sandboxMode boxlite" in rejected_local.json()["detail"]

        created = client.post(
            "/api/v1/admin/managed-nodes",
            json={
                "employeeId": "alice",
                "provider": "local-process",
                "sandboxMode": "boxlite",
            },
        )
        assert created.status_code == 202
        managed_node = created.json()["node"]

        [placeholder] = client.get("/api/v1/admin/daemon-nodes").json()["nodes"]
        assert placeholder["id"] == managed_node["id"]
        assert placeholder["managedNodeId"] == managed_node["id"]
        assert placeholder["provisioningPlaceholder"] is True
        assert placeholder["status"] == "provisioning"
        assert placeholder["online"] is False
        assert placeholder["stale"] is False

        attempt_response = client.post(
            f"/api/v1/admin/managed-nodes/{managed_node['id']}/attempts"
        )
        assert attempt_response.status_code == 201
        credential = attempt_response.json()["enrollmentCredential"]

        enrollment = client.post(
            "/api/v1/daemon-node-enrollments",
            json={"workspacePath": "/workspace/alice"},
            headers={"Authorization": f"Enrollment {credential}"},
        )
        assert enrollment.status_code == 201
        runtime = enrollment.json()
        assert runtime["sandboxMode"] == "boxlite"
        assert runtime["heartbeat"] == {"intervalMs": 5_000, "timeoutMs": 15_000}

        duplicate = client.post(
            "/api/v1/daemon-node-enrollments",
            json={"workspacePath": "/workspace/alice"},
            headers={"Authorization": f"Enrollment {credential}"},
        )
        assert duplicate.status_code == 201
        assert duplicate.json() == runtime

        registered = client.post(
            "/api/v1/daemon-node-registrations",
            json={
                "sandboxId": runtime["sandboxId"],
                "token": runtime["token"],
                "workspacePath": "/workspace/alice",
                "sandboxMode": "boxlite",
                "protocolVersion": 1,
                "supportedAgents": ["codex"],
                "capabilities": ["thread-workspaces"],
                "status": "ready",
            },
        )
        assert registered.status_code == 200
        assert registered.json()["managedNodeId"] == managed_node["id"]
        assert registered.json()["heartbeat"] == {
            "intervalMs": 5_000,
            "timeoutMs": 15_000,
        }

        # Enrollment and readiness can beat the provider's allocation response.
        attempt_id = attempt_response.json()["attempt"]["id"]
        late_provider = client.patch(
            f"/api/v1/admin/managed-nodes/{managed_node['id']}/attempts/{attempt_id}",
            json={"status": "registering", "providerInstanceId": "local-process:fixture"},
        )
        assert late_provider.status_code == 200
        assert late_provider.json()["attempt"]["status"] == "succeeded"
        assert late_provider.json()["attempt"]["providerInstanceId"] == "local-process:fixture"

        managed = client.get(f"/api/v1/admin/managed-nodes/{managed_node['id']}")
        assert managed.status_code == 200
        assert managed.json()["node"]["phase"] == "ready"
        control_panel_node = client.get("/api/v1/admin/daemon-nodes").json()["nodes"][0]
        assert control_panel_node["managedNodeId"] == managed_node["id"]
        assert control_panel_node["displayName"] == managed_node["displayName"]
        assert "nodeToken" not in control_panel_node

        alice_client = TestClient(app)
        _login(alice_client, "alice", "userpass")
        assert [
            node["id"]
            for node in alice_client.get("/api/v1/daemon-nodes").json()["nodes"]
        ] == [runtime["sandboxId"]]

        deleted = client.delete(f"/api/v1/admin/managed-nodes/{managed_node['id']}")
        assert deleted.status_code == 202
        assert deleted.json()["node"]["desiredState"] == "deleted"
        fenced = client.app.state.registry.get(runtime["sandboxId"])
        assert fenced["status"] == "stopped"
        assert fenced["retiredAt"]
        heartbeat = client.post(
            "/api/v1/daemon-node-registrations",
            json={
                "sandboxId": runtime["sandboxId"],
                "token": runtime["token"],
                "workspacePath": "/workspace/alice",
                "sandboxMode": "boxlite",
                "protocolVersion": 1,
                "supportedAgents": ["codex"],
                "capabilities": ["thread-workspaces"],
                "status": "ready",
            },
        )
        assert heartbeat.status_code == 200
        assert heartbeat.json()["status"] == "stopped"
        assert client.get("/api/v1/admin/daemon-nodes").json()["nodes"] == []
        assert alice_client.get("/api/v1/daemon-nodes").json()["nodes"] == []


def test_employee_daemon_list_replaces_retired_managed_runtime_with_one_placeholder(
    monkeypatch,
) -> None:
    monkeypatch.setenv("RELAY_ADMIN_TOKEN", "admin_token")
    with TemporaryDirectory() as root:
        app = create_app(root)
        client = TestClient(app)
        _bootstrap_admin(client)
        _create_user(client, "alice", employee_id="alice")
        managed = app.state.managed_node_store.create_node(
            {"employeeId": "alice", "displayName": "Alice cloud"}
        )
        app.state.managed_node_store.create_node(
            {"employeeId": "bob", "displayName": "Bob cloud"}
        )
        attempt, _credential = app.state.managed_node_store.create_attempt(
            managed["id"]
        )
        runtime, runtime_token = app.state.registry.enroll_managed_node(
            managed,
            attempt,
            {"workspacePath": "/workspace/alice"},
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
        app.state.registry.fence_managed_node(runtime["id"])
        _login(client, "alice", "userpass")

        response = client.get("/api/v1/daemon-nodes")

        assert response.status_code == 200
        [visible] = response.json()["nodes"]
        assert visible["id"] == managed["id"]
        assert visible["managedNodeId"] == managed["id"]
        assert visible["displayName"] == "Alice cloud"
        assert visible["provisioningPlaceholder"] is True
        assert visible["status"] == "provisioning"
        assert visible["online"] is False


def test_employee_daemon_list_hides_superseded_local_runtime(monkeypatch) -> None:
    monkeypatch.setenv("RELAY_ADMIN_TOKEN", "admin_token")
    with TemporaryDirectory() as root:
        app = create_app(root)
        client = TestClient(app)
        _bootstrap_admin(client)
        _create_user(client, "alice", employee_id="alice")
        common = {
            "employeeId": "alice",
            "workspaceId": "alice-machine",
            "workspacePath": "/workspace/alice",
            "protocolVersion": 1,
            "supportedAgents": ["codex"],
            "capabilities": ["thread-workspaces"],
            "status": "ready",
        }
        app.state.registry.register(
            {**common, "sandboxId": "local_old", "token": "old-token"},
            authorized_node_location="employee-device",
        )
        app.state.registry.register(
            {**common, "sandboxId": "local_current", "token": "current-token"},
            authorized_node_location="employee-device",
        )
        _login(client, "alice", "userpass")

        response = client.get("/api/v1/daemon-nodes")

        assert response.status_code == 200
        assert [node["id"] for node in response.json()["nodes"]] == ["local_current"]


def test_legacy_managed_node_with_retired_policy_can_be_deleted(monkeypatch) -> None:
    monkeypatch.setenv("RELAY_ADMIN_TOKEN", "admin_token")
    with TemporaryDirectory() as root:
        app = create_app(root)
        client = TestClient(app)
        _bootstrap_admin(client)
        _login_admin(client)

        node = app.state.managed_node_store.create_node({"employeeId": "alice"})
        app.state.managed_node_store._write_node(
            {
                **node,
                "displayName": "Managed node for pool",
                "assignmentMode": "pooled",
                "sandboxMode": "none",
                "workspacePolicy": {"kind": "managed-pool"},
            }
        )

        deleted = client.delete(f"/api/v1/admin/managed-nodes/{node['id']}")

        assert deleted.status_code == 202
        assert deleted.json()["node"]["desiredState"] == "deleted"


def test_admin_can_recover_deleted_managed_node(monkeypatch) -> None:
    monkeypatch.setenv("RELAY_ADMIN_TOKEN", "admin_token")
    with TemporaryDirectory() as root:
        app = create_app(root)
        client = TestClient(app)
        _bootstrap_admin(client)
        _login_admin(client)
        _create_user(client, "alice", employee_id="alice")

        created = client.post(
            "/api/v1/admin/managed-nodes",
            json={"employeeId": "alice", "sandboxMode": "boxlite"},
        ).json()["node"]

        active = client.post(f"/api/v1/admin/managed-nodes/{created['id']}/recover")
        assert active.status_code == 409
        assert "deleted" in active.json()["detail"]

        app.state.managed_node_store.update_node(
            created["id"], {"desiredState": "deleted"}
        )
        deleting = client.post(f"/api/v1/admin/managed-nodes/{created['id']}/recover")
        assert deleting.status_code == 409
        assert "still being deleted" in deleting.json()["detail"]

        app.state.managed_node_store.update_node(created["id"], {"phase": "deleted"})

        recovered = client.post(f"/api/v1/admin/managed-nodes/{created['id']}/recover")

        assert recovered.status_code == 202
        node = recovered.json()["node"]
        assert node["desiredState"] == "running"
        assert node["phase"] == "requested"
        assert node["generation"] == created["generation"] + 2
        assert "activeAttemptId" not in node

        missing = client.post("/api/v1/admin/managed-nodes/nodes_missing/recover")
        assert missing.status_code == 404


def test_recovered_managed_node_reattaches_the_original_agent(monkeypatch) -> None:
    """Deleting the managed node only removes its placement — the agent
    itself was declared explicitly by the employee and is never erased by the
    system. After recovery, re-registering backfills a placement for that
    same agent; no fresh agent declaration is needed."""
    monkeypatch.setenv("RELAY_ADMIN_TOKEN", "admin_token")
    with TemporaryDirectory() as root:
        app = create_app(root)
        client = TestClient(app)
        _bootstrap_admin(client)
        _login_admin(client)

        managed = app.state.managed_node_store.create_node({"employeeId": "alice"})
        attempt, _credential = app.state.managed_node_store.create_attempt(
            managed["id"]
        )
        runtime, token = app.state.registry.enroll_managed_node(
            managed, attempt, {"workspacePath": "/workspace"}
        )
        app.state.managed_node_store.complete_enrollment(
            managed["id"], attempt["id"], runtime["id"]
        )
        original = app.state.agent_store.create_agent(
            "alice",
            {
                "displayName": "Claude",
                "executorKind": "claude",
                "defaultRole": "implementer",
                "computerId": f"managed:{managed['id']}",
            },
        )
        registered = client.post(
            "/api/v1/daemon-node-registrations",
            json={
                "sandboxId": runtime["id"],
                "token": token,
                "protocolVersion": 1,
                "supportedAgents": ["claude"],
                "capabilities": ["thread-workspaces"],
                "status": "ready",
            },
        )
        assert registered.status_code == 200, registered.text

        deleted = client.delete(f"/api/v1/admin/managed-nodes/{managed['id']}")
        assert deleted.status_code == 202, deleted.text
        app.state.managed_node_store.update_node(managed["id"], {"phase": "deleted"})
        # Deleting the computer only removed the original agent's placement.
        assert not app.state.agent_store.get_agent(original["id"]).get("deletedAt")
        assert (
            app.state.agent_placement_store.list_placements(agent_id=original["id"])
            == []
        )
        recovered = client.post(f"/api/v1/admin/managed-nodes/{managed['id']}/recover")
        assert recovered.status_code == 202, recovered.text

        replacement_attempt, _credential = app.state.managed_node_store.create_attempt(
            managed["id"]
        )
        replacement, replacement_token = app.state.registry.enroll_managed_node(
            app.state.managed_node_store.get_node(managed["id"]),
            replacement_attempt,
            {"workspacePath": "/workspace"},
        )
        app.state.managed_node_store.complete_enrollment(
            managed["id"], replacement_attempt["id"], replacement["id"]
        )

        re_registered = client.post(
            "/api/v1/daemon-node-registrations",
            json={
                "sandboxId": replacement["id"],
                "token": replacement_token,
                "protocolVersion": 1,
                "supportedAgents": ["claude"],
                "capabilities": ["thread-workspaces"],
                "status": "ready",
            },
        )
        assert re_registered.status_code == 200, re_registered.text

        # Re-registering the recovered computer backfills a placement for the
        # same declared agent — no new agent is required.
        [placement] = app.state.agent_placement_store.list_placements(
            agent_id=original["id"]
        )
        nodes = {node["id"]: node for node in app.state.registry.monitor_nodes()}
        assert placement_node(placement, nodes)["id"] == replacement["id"]


def test_recovered_managed_node_conflicts_with_replacement_policy_slot(
    monkeypatch,
) -> None:
    monkeypatch.setenv("RELAY_ADMIN_TOKEN", "admin_token")
    with TemporaryDirectory() as root:
        app = create_app(root)
        client = TestClient(app)
        _bootstrap_admin(client)
        _login_admin(client)
        _create_user(client, "alice", employee_id="alice")

        created = client.post(
            "/api/v1/admin/managed-nodes",
            json={"employeeId": "alice", "sandboxMode": "boxlite"},
        ).json()["node"]
        app.state.managed_node_store.update_node(
            created["id"], {"desiredState": "deleted"}
        )
        app.state.managed_node_store.update_node(created["id"], {"phase": "deleted"})
        client.post(
            "/api/v1/admin/managed-nodes",
            json={"employeeId": "alice", "sandboxMode": "boxlite"},
        )

        recovered = client.post(f"/api/v1/admin/managed-nodes/{created['id']}/recover")

        assert recovered.status_code == 409
        assert "policy slot" in recovered.json()["detail"]


def test_admin_can_permanently_delete_terminal_managed_node_record(
    monkeypatch,
) -> None:
    monkeypatch.setenv("RELAY_ADMIN_TOKEN", "admin_token")
    with TemporaryDirectory() as root:
        app = create_app(root)
        client = TestClient(app)
        _bootstrap_admin(client)
        _login_admin(client)
        _create_user(client, "alice", employee_id="alice")

        created = client.post(
            "/api/v1/admin/managed-nodes",
            json={"employeeId": "alice", "sandboxMode": "boxlite"},
        ).json()["node"]

        premature = client.delete(f"/api/v1/admin/managed-nodes/{created['id']}/record")
        assert premature.status_code == 409
        assert "finish deletion" in premature.json()["detail"]

        app.state.managed_node_store.update_node(
            created["id"], {"desiredState": "deleted"}
        )
        app.state.managed_node_store.update_node(created["id"], {"phase": "deleted"})

        purged = client.delete(f"/api/v1/admin/managed-nodes/{created['id']}/record")

        assert purged.status_code == 204
        assert (
            client.get(f"/api/v1/admin/managed-nodes/{created['id']}").status_code
            == 404
        )


def test_permanent_delete_retires_leftover_managed_runtime(monkeypatch) -> None:
    monkeypatch.setenv("RELAY_ADMIN_TOKEN", "admin_token")
    with TemporaryDirectory() as root:
        app = create_app(root)
        client = TestClient(app)
        _bootstrap_admin(client)
        _login_admin(client)

        managed = app.state.managed_node_store.create_node({"employeeId": "alice"})
        attempt, _credential = app.state.managed_node_store.create_attempt(
            managed["id"]
        )
        runtime, runtime_token = app.state.registry.enroll_managed_node(
            managed,
            attempt,
            {"workspacePath": "/workspace"},
        )
        app.state.managed_node_store.complete_enrollment(
            managed["id"], attempt["id"], runtime["id"]
        )
        app.state.registry.register(
            {
                "sandboxId": runtime["id"],
                "token": runtime_token,
                "protocolVersion": 1,
                "supportedAgents": ["codex"],
                "capabilities": ["thread-workspaces"],
                "status": "ready",
            }
        )
        deleted = client.delete(f"/api/v1/admin/managed-nodes/{managed['id']}")
        assert deleted.status_code == 202, deleted.text
        app.state.managed_node_store.update_node(managed["id"], {"phase": "deleted"})

        purged = client.delete(f"/api/v1/admin/managed-nodes/{managed['id']}/record")

        assert purged.status_code == 204, purged.text
        assert app.state.registry.get(runtime["id"]) is None
        assert app.state.managed_node_store.get_node(managed["id"]) is None


def test_delete_managed_node_cleans_orphaned_runtime(monkeypatch) -> None:
    monkeypatch.setenv("RELAY_ADMIN_TOKEN", "admin_token")
    with TemporaryDirectory() as root:
        app = create_app(root)
        client = TestClient(app)
        _bootstrap_admin(client)
        _login_admin(client)

        managed = app.state.managed_node_store.create_node({"employeeId": "alice"})
        attempt, _credential = app.state.managed_node_store.create_attempt(
            managed["id"]
        )
        runtime, runtime_token = app.state.registry.enroll_managed_node(
            managed,
            attempt,
            {"workspacePath": "/workspace"},
        )
        app.state.managed_node_store.complete_enrollment(
            managed["id"], attempt["id"], runtime["id"]
        )
        app.state.registry.register(
            {
                "sandboxId": runtime["id"],
                "token": runtime_token,
                "protocolVersion": 1,
                "supportedAgents": ["codex"],
                "capabilities": ["thread-workspaces"],
                "status": "ready",
            }
        )
        app.state.managed_node_store.update_node(
            managed["id"], {"desiredState": "deleted"}
        )
        app.state.managed_node_store.update_node(managed["id"], {"phase": "deleted"})
        app.state.managed_node_store.purge_node(managed["id"])

        deleted = client.delete(f"/api/v1/admin/managed-nodes/{managed['id']}")

        assert deleted.status_code == 204, deleted.text
        assert app.state.registry.get(runtime["id"]) is None
        assert client.get("/api/v1/admin/daemon-nodes").json()["nodes"] == []


def test_managed_node_runtime_cannot_be_drained_or_retired_during_active_run(
    monkeypatch,
) -> None:
    monkeypatch.setenv("RELAY_ADMIN_TOKEN", "admin_token")
    with TemporaryDirectory() as root:
        app = create_app(root)
        client = TestClient(app)
        _bootstrap_admin(client)
        _login_admin(client)

        managed = app.state.managed_node_store.create_node({"employeeId": "alice"})
        runtime_id = "sbx_busy_managed"
        app.state.managed_node_store._write_node(
            {
                **managed,
                "activeDaemonNodeId": runtime_id,
                "phase": "ready",
            }
        )
        app.state.registry.register(
            {
                "sandboxId": runtime_id,
                "employeeId": "alice",
                "token": "node_token",
                "protocolVersion": 1,
                "supportedAgents": ["codex"],
                "capabilities": ["thread-workspaces"],
                "status": "ready",
            }
        )
        app.state.registry.daemon_store.create_run_request(
            {
                "nodeId": runtime_id,
                "sessionId": "session_busy_managed",
                "taskGoal": "Keep this runtime busy",
                "assignments": [],
                "state": {},
            }
        )

        drained = client.patch(
            f"/api/v1/admin/managed-nodes/{managed['id']}",
            json={"desiredState": "stopped"},
        )
        retired = client.delete(f"/api/v1/admin/managed-nodes/{managed['id']}/runtime")

        assert drained.status_code == 409
        assert retired.status_code == 409
        assert app.state.registry.get(runtime_id) is not None
        assert (
            app.state.managed_node_store.get_node(managed["id"])["desiredState"]
            == "running"
        )


def test_running_managed_runtime_retirement_preserves_agent_and_placement(
    monkeypatch,
) -> None:
    monkeypatch.setenv("RELAY_ADMIN_TOKEN", "admin_token")
    with TemporaryDirectory() as root:
        app = create_app(root)
        client = TestClient(app)
        _bootstrap_admin(client)
        _login_admin(client)
        managed = app.state.managed_node_store.create_node({"employeeId": "alice"})
        attempt, _credential = app.state.managed_node_store.create_attempt(
            managed["id"]
        )
        runtime, runtime_token = app.state.registry.enroll_managed_node(
            managed,
            attempt,
            {"workspacePath": "/workspace"},
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
            "alice",
            {
                "displayName": "Codex",
                "executorKind": "codex",
                "defaultRole": "implementer",
                "computerId": f"managed:{managed['id']}",
            },
        )
        sync_node_agents(app.state, runtime)
        [placement] = app.state.agent_placement_store.list_placements(
            agent_id=agent["id"]
        )

        response = client.delete(f"/api/v1/admin/managed-nodes/{managed['id']}/runtime")

        assert response.status_code == 204, response.text
        retired = app.state.registry.get(runtime["id"])
        assert retired["managedNodeId"] == managed["id"]
        assert retired["retiredAt"]
        assert retired["status"] == "stopped"
        reconnected = app.state.registry.register(
            {
                "sandboxId": runtime["id"],
                "token": runtime_token,
                "protocolVersion": 1,
                "supportedAgents": ["codex"],
                "status": "ready",
            }
        )
        assert reconnected["managedNodeId"] == managed["id"]
        assert reconnected["retiredAt"]
        assert reconnected["status"] == "stopped"
        assert not app.state.agent_store.get_agent(agent["id"]).get("deletedAt")
        [preserved] = app.state.agent_placement_store.list_placements(
            agent_id=agent["id"]
        )
        assert preserved["id"] == placement["id"]
        assert preserved["daemonNodeId"] == runtime["id"]


def test_stopped_managed_runtime_preserves_agent_for_restart(monkeypatch) -> None:
    monkeypatch.setenv("RELAY_ADMIN_TOKEN", "admin_token")
    with TemporaryDirectory() as root:
        app = create_app(root)
        client = TestClient(app)
        _bootstrap_admin(client)
        _login_admin(client)
        managed = app.state.managed_node_store.create_node({"employeeId": "alice"})
        attempt, _credential = app.state.managed_node_store.create_attempt(
            managed["id"]
        )
        runtime, runtime_token = app.state.registry.enroll_managed_node(
            managed,
            attempt,
            {"workspacePath": "/workspace"},
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
            "alice",
            {
                "displayName": "Codex",
                "executorKind": "codex",
                "defaultRole": "implementer",
                "computerId": f"managed:{managed['id']}",
            },
        )
        sync_node_agents(app.state, runtime)
        [placement] = app.state.agent_placement_store.list_placements(
            agent_id=agent["id"]
        )
        app.state.managed_node_store.update_node(
            managed["id"], {"desiredState": "stopped"}
        )

        response = client.delete(f"/api/v1/admin/managed-nodes/{managed['id']}/runtime")

        assert response.status_code == 204, response.text
        [visible] = client.get("/api/v1/daemon-nodes").json()["nodes"]
        assert visible["id"] == managed["id"]
        assert visible["managedNodeId"] == managed["id"]
        assert visible["provisioningPlaceholder"] is True
        assert visible["status"] == "stopped"
        assert not app.state.agent_store.get_agent(agent["id"]).get("deletedAt")
        [preserved] = app.state.agent_placement_store.list_placements(
            agent_id=agent["id"]
        )
        assert preserved["id"] == placement["id"]
        assert preserved["managedNodeId"] == managed["id"]


def test_backend_startup_does_not_reconcile_runtime_capabilities_into_agents(
    monkeypatch,
) -> None:
    monkeypatch.setenv("RELAY_ADMIN_TOKEN", "admin_token")
    with TemporaryDirectory() as root:
        original = create_app(root)
        managed = original.state.managed_node_store.create_node({"employeeId": "alice"})
        attempt, _credential = original.state.managed_node_store.create_attempt(
            managed["id"]
        )
        runtime, runtime_token = original.state.registry.enroll_managed_node(
            managed,
            attempt,
            {"workspacePath": "/workspace"},
        )
        original.state.managed_node_store.complete_enrollment(
            managed["id"], attempt["id"], runtime["id"]
        )
        runtime = original.state.registry.register(
            {
                "sandboxId": runtime["id"],
                "token": runtime_token,
                "protocolVersion": 1,
                "supportedAgents": ["codex"],
                "capabilities": ["thread-workspaces"],
                "status": "ready",
            }
        )
        legacy = original.state.agent_store.ensure_compatibility_agent(
            "alice", "codex", runtime["id"]
        )
        original.state.agent_placement_store.create_placement(legacy, runtime["id"])
        old_runtime_id = runtime["id"]
        original.state.registry.delete(old_runtime_id)
        replacement_attempt, _credential = (
            original.state.managed_node_store.create_attempt(managed["id"])
        )
        replacement, replacement_token = original.state.registry.enroll_managed_node(
            original.state.managed_node_store.get_node(managed["id"]),
            replacement_attempt,
            {"workspacePath": "/workspace"},
        )
        original.state.managed_node_store.complete_enrollment(
            managed["id"], replacement_attempt["id"], replacement["id"]
        )
        replacement = original.state.registry.register(
            {
                "sandboxId": replacement["id"],
                "token": replacement_token,
                "protocolVersion": 1,
                "supportedAgents": ["codex"],
                "capabilities": ["thread-workspaces"],
                "status": "ready",
            }
        )

        original_list_placements = LocalAgentPlacementStore.list_placements

        def reject_agent_scoped_startup_query(store, *args, **kwargs):
            if kwargs.get("agent_id") is not None:
                raise AssertionError("backend startup queried one Agent's placements")
            return original_list_placements(store, *args, **kwargs)

        with monkeypatch.context() as startup_patch:
            startup_patch.setattr(
                LocalAgentPlacementStore,
                "list_placements",
                reject_agent_scoped_startup_query,
            )
            restarted = create_app(root)

        [current] = [
            item
            for item in restarted.state.agent_store.list_agents(
                supervisor_employee_id="alice"
            )
            if item["executorKind"] == "codex"
        ]
        assert current["id"] == legacy["id"]
        assert current["compatibilityKey"] == legacy["compatibilityKey"]
        assert not current.get("deletedAt")
        [placement] = restarted.state.agent_placement_store.list_placements(
            agent_id=legacy["id"]
        )
        assert placement["daemonNodeId"] == old_runtime_id
        assert placement["daemonNodeId"] != replacement["id"]


def test_failed_managed_node_is_visible_as_failed(monkeypatch) -> None:
    monkeypatch.setenv("RELAY_ADMIN_TOKEN", "admin_token")
    with TemporaryDirectory() as root:
        client = TestClient(create_app(root))
        _bootstrap_admin(client)
        _login_admin(client)
        _create_user(client, "alice", employee_id="alice")
        managed = client.post(
            "/api/v1/admin/managed-nodes",
            json={"employeeId": "alice", "sandboxMode": "boxlite"},
        ).json()["node"]
        attempt = client.post(
            f"/api/v1/admin/managed-nodes/{managed['id']}/attempts"
        ).json()["attempt"]

        failed = client.patch(
            f"/api/v1/admin/managed-nodes/{managed['id']}/attempts/{attempt['id']}",
            json={"status": "failed", "errorMessage": "provider unavailable"},
        )

        assert failed.status_code == 200
        [placeholder] = client.get("/api/v1/admin/daemon-nodes").json()["nodes"]
        assert placeholder["status"] == "failed"
        assert placeholder["lastError"] == "provider unavailable"


def test_fastapi_daemon_routes_register_and_poll(monkeypatch) -> None:
    monkeypatch.setenv("RELAY_ADMIN_TOKEN", "admin_token")
    with TemporaryDirectory() as root:
        app = create_app(root)
        client = TestClient(app)
        _bootstrap_admin(client)
        _login_admin(client)
        response = client.post(
            "/api/v1/daemon-node-registrations",
            json={
                "sandboxId": "sbx_alice",
                "employeeId": "alice",
                "token": "node_token",
                "workspacePath": "/workspace/alice",
                "protocolVersion": 1,
                "supportedAgents": ["claude", "codex"],
                "capabilities": ["thread-workspaces"],
                "status": "ready",
            },
            headers={"Authorization": "Bearer ui_token"},
        )

        assert response.status_code == 200
        assert response.json()["agents"]["codex"] == "ready"
        response = client.get(
            "/api/v1/daemon-nodes/sbx_alice/commands",
            headers={"Authorization": "Bearer node_token"},
        )
        assert response.status_code == 200
        assert response.json() == {"commands": []}

        run = client.post(
            "/api/v1/sandboxes/sbx_alice/runs",
            json={
                "taskGoal": "review auth",
                "assignments": [{"agent": "codex"}],
            },
            headers={"Authorization": "Bearer ui_token"},
        )
        assert run.status_code == 202
        response = client.get(
            "/api/v1/daemon-nodes/sbx_alice/commands?limit=1&leaseSeconds=5",
            headers={"Authorization": "Bearer node_token"},
        )
        assert response.status_code == 200
        [command] = response.json()["commands"]
        assert command["type"] == "run.start"
        assert command["attempt"] == 1
        assert command["leaseId"].startswith("lease_")
        assert command["leaseExpiresAt"]

        response = client.get(
            "/api/v1/daemon-nodes/sbx_alice/commands?limit=0",
            headers={"Authorization": "Bearer node_token"},
        )
        assert response.status_code == 400
        response = client.get(
            "/api/v1/daemon-nodes/sbx_alice/commands?waitSeconds=NaN",
            headers={"Authorization": "Bearer node_token"},
        )
        assert response.status_code == 400
        response = client.get("/api/v1/admin/daemon-nodes")
        assert response.status_code == 200
        assert response.json()["nodes"][0].get("nodeToken") == "node_token"


def test_explicit_command_leases_redeliver_work_missing_from_daemon_heartbeat(
    monkeypatch,
) -> None:
    monkeypatch.setenv("RELAY_ADMIN_TOKEN", "admin_token")
    with TemporaryDirectory() as root:
        app = create_app(root)
        client = TestClient(app)
        _bootstrap_admin(client)
        _login_admin(client)
        response = client.post(
            "/api/v1/daemon-node-registrations",
            json={
                "sandboxId": "sbx_alice",
                "employeeId": "alice",
                "token": "node_token",
                "workspacePath": "/workspace/alice",
                "protocolVersion": 1,
                "supportedAgents": ["codex"],
                "capabilities": ["thread-workspaces"],
                "status": "ready",
            },
            headers={"Authorization": "Bearer ui_token"},
        )
        assert response.status_code == 200

        run = client.post(
            "/api/v1/sandboxes/sbx_alice/runs",
            json={
                "taskGoal": "recover this run",
                "assignments": [{"agent": "codex"}],
            },
            headers={"Authorization": "Bearer ui_token"},
        )
        assert run.status_code == 202

        first = client.get(
            "/api/v1/daemon-nodes/sbx_alice/commands?leaseMode=explicit&leaseSeconds=1",
            headers={"Authorization": "Bearer node_token"},
        )
        assert first.status_code == 200
        [first_command] = first.json()["commands"]
        assert first_command["attempt"] == 1

        time.sleep(1.05)

        second = client.get(
            "/api/v1/daemon-nodes/sbx_alice/commands?leaseMode=explicit&leaseSeconds=1",
            headers={"Authorization": "Bearer node_token"},
        )
        assert second.status_code == 200
        [second_command] = second.json()["commands"]
        assert second_command["id"] == first_command["id"]
        assert second_command["attempt"] == 2
        assert second_command["leaseId"] != first_command["leaseId"]

        stale_output = client.post(
            "/api/v1/daemon-nodes/sbx_alice/events",
            json={
                "type": "run.output",
                "commandId": first_command["id"],
                "leaseId": first_command["leaseId"],
                "sessionId": first_command["sessionId"],
                "runId": first_command["runId"],
                "agent": first_command["agent"],
                "stream": "stdout",
                "text": "superseded delivery",
                "sequence": 0,
            },
            headers={"Authorization": "Bearer node_token"},
        )
        assert stale_output.status_code == 401

        current_output = client.post(
            "/api/v1/daemon-nodes/sbx_alice/events",
            json={
                "type": "run.output",
                "commandId": second_command["id"],
                "leaseId": second_command["leaseId"],
                "sessionId": second_command["sessionId"],
                "runId": second_command["runId"],
                "agent": second_command["agent"],
                "stream": "stdout",
                "text": "current delivery",
                "sequence": 0,
            },
            headers={"Authorization": "Bearer node_token"},
        )
        assert current_output.status_code == 200


def test_output_event_does_not_replace_explicit_lease_heartbeat(monkeypatch) -> None:
    monkeypatch.setenv("RELAY_ADMIN_TOKEN", "admin_token")
    with TemporaryDirectory() as root:
        app = create_app(root)
        client = TestClient(app)
        _bootstrap_admin(client)
        _login_admin(client)
        response = client.post(
            "/api/v1/daemon-node-registrations",
            json={
                "sandboxId": "sbx_alice",
                "employeeId": "alice",
                "token": "node_token",
                "workspacePath": "/workspace/alice",
                "protocolVersion": 1,
                "supportedAgents": ["codex"],
                "capabilities": ["thread-workspaces"],
                "status": "ready",
            },
            headers={"Authorization": "Bearer ui_token"},
        )
        assert response.status_code == 200

        run = client.post(
            "/api/v1/sandboxes/sbx_alice/runs",
            json={
                "taskGoal": "recover after output",
                "assignments": [{"agent": "codex"}],
            },
            headers={"Authorization": "Bearer ui_token"},
        )
        assert run.status_code == 202
        [first] = client.get(
            "/api/v1/daemon-nodes/sbx_alice/commands?leaseMode=explicit&leaseSeconds=1",
            headers={"Authorization": "Bearer node_token"},
        ).json()["commands"]

        output = client.post(
            "/api/v1/daemon-nodes/sbx_alice/events",
            json={
                "type": "run.output",
                "commandId": first["id"],
                "leaseId": first["leaseId"],
                "sessionId": first["sessionId"],
                "runId": first["runId"],
                "agent": first["agent"],
                "stream": "stdout",
                "text": "still working\n",
                "sequence": 0,
            },
            headers={"Authorization": "Bearer node_token"},
        )
        assert output.status_code == 200

        time.sleep(1.05)

        [redelivered] = client.get(
            "/api/v1/daemon-nodes/sbx_alice/commands?leaseMode=explicit&leaseSeconds=1",
            headers={"Authorization": "Bearer node_token"},
        ).json()["commands"]
        assert redelivered["id"] == first["id"]
        assert redelivered["attempt"] == 2


def test_run_completed_finalizes_even_when_token_usage_is_unusable(monkeypatch) -> None:
    """A malformed usage report must not strand the run.

    The daemon posts its terminal event once and drops it on rejection. If the
    backend 400s the whole event over telemetry, the session stays "running"
    and — runs being exclusive per node — every later dispatch is refused until
    the run timeout reaps it. The counts are dropped; the run completes.
    """
    monkeypatch.setenv("RELAY_ADMIN_TOKEN", "admin_token")
    with TemporaryDirectory() as root:
        app = create_app(root)
        client = TestClient(app)
        _bootstrap_admin(client)
        _login_admin(client)
        assert (
            client.post(
                "/api/v1/daemon-node-registrations",
                json={
                    "sandboxId": "sbx_alice",
                    "employeeId": "alice",
                    "token": "node_token",
                    "workspacePath": "/workspace/alice",
                    "protocolVersion": 1,
                    "supportedAgents": ["codex"],
                    "capabilities": ["thread-workspaces"],
                    "status": "ready",
                },
                headers={"Authorization": "Bearer ui_token"},
            ).status_code
            == 200
        )
        run = client.post(
            "/api/v1/sandboxes/sbx_alice/runs",
            json={
                "taskGoal": "report broken usage",
                "assignments": [{"agent": "codex"}],
            },
            headers={"Authorization": "Bearer ui_token"},
        )
        assert run.status_code == 202
        session_id = run.json()["id"]
        [command] = client.get(
            "/api/v1/daemon-nodes/sbx_alice/commands?leaseMode=explicit&leaseSeconds=90",
            headers={"Authorization": "Bearer node_token"},
        ).json()["commands"]

        completed = client.post(
            "/api/v1/daemon-nodes/sbx_alice/events",
            json={
                "type": "run.completed",
                "commandId": command["id"],
                "leaseId": command["leaseId"],
                "sessionId": command["sessionId"],
                "runId": command["runId"],
                "agent": command["agent"],                "exitCode": 0,
                "agentLog": "[Codex Action Exit 0]",
                "tokenUsage": {"input": 1, "output": 1, "cache": 0, "total": 9},
            },
            headers={"Authorization": "Bearer node_token"},
        )
        assert completed.status_code == 200

        session = client.get(f"/api/v1/threads/{session_id}").json()
        assert session["status"] == "completed"
        assert session.get("tokenUsage") is None
        node = next(
            item
            for item in client.get("/api/v1/daemon-nodes").json()["nodes"]
            if item["id"] == "sbx_alice"
        )
        assert node["activeRuns"] == []


def test_daemon_delivery_output_reaches_the_canonical_session_stream(
    monkeypatch,
) -> None:
    monkeypatch.setenv("RELAY_ADMIN_TOKEN", "admin_token")
    with TemporaryDirectory() as root:
        app = create_app(root)
        client = TestClient(app)
        _bootstrap_admin(client)
        _login_admin(client)
        registered = client.post(
            "/api/v1/daemon-node-registrations",
            json={
                "sandboxId": "sbx_alice",
                "employeeId": "alice",
                "token": "node_token",
                "workspacePath": "/workspace/alice",
                "protocolVersion": 1,
                "supportedAgents": ["codex"],
                "capabilities": ["thread-workspaces"],
                "status": "ready",
            },
            headers={"Authorization": "Bearer ui_token"},
        )
        assert registered.status_code == 200
        run = client.post(
            "/api/v1/sandboxes/sbx_alice/runs",
            json={
                "taskGoal": "stream this answer",
                "assignments": [{"agent": "codex"}],
            },
            headers={"Authorization": "Bearer ui_token"},
        )
        assert run.status_code == 202
        session_id = run.json()["id"]
        [command] = client.get(
            "/api/v1/daemon-nodes/sbx_alice/commands?leaseMode=explicit&leaseSeconds=90",
            headers={"Authorization": "Bearer node_token"},
        ).json()["commands"]

        output = client.post(
            "/api/v1/daemon-nodes/sbx_alice/events",
            json={
                "type": "run.output",
                "commandId": command["id"],
                "leaseId": command["leaseId"],
                "sessionId": command["sessionId"],
                "runId": command["runId"],
                "agent": command["agent"],
                "stream": "stdout",
                "text": "hello from the daemon",
                "sequence": 0,
            },
            headers={"Authorization": "Bearer node_token"},
        )
        assert output.status_code == 200
        collaboration_payload = {
            "id": "collab-1",
            "tool": "spawnAgent",
            "status": "completed",
            "senderThreadId": "root-thread",
            "receiverThreadIds": ["child-thread"],
            "prompt": "Review the change",
            "model": None,
            "reasoningEffort": None,
            "agentsStates": {
                "child-thread": {"status": "running", "message": "Reviewing"}
            },
        }
        collaboration = client.post(
            "/api/v1/daemon-nodes/sbx_alice/events",
            json={
                "type": "run.collaboration",
                "commandId": command["id"],
                "leaseId": command["leaseId"],
                "sessionId": command["sessionId"],
                "runId": command["runId"],
                "agent": command["agent"],                "collaboration": collaboration_payload,
                "sequence": 1,
            },
            headers={"Authorization": "Bearer node_token"},
        )
        assert collaboration.status_code == 200
        completed = client.post(
            "/api/v1/daemon-nodes/sbx_alice/events",
            json={
                "type": "run.completed",
                "commandId": command["id"],
                "leaseId": command["leaseId"],
                "sessionId": command["sessionId"],
                "runId": command["runId"],
                "agent": command["agent"],                "exitCode": 0,
            },
            headers={"Authorization": "Bearer node_token"},
        )
        assert completed.status_code == 200

        stream = client.get(f"/api/v1/threads/{session_id}/events")
        payloads = [
            json.loads(line.removeprefix("data: "))
            for line in stream.text.splitlines()
            if line.startswith("data: {")
        ]
        assert [
            event["text"] for event in payloads if event.get("type") == "agent.output"
        ] == ["hello from the daemon"]
        assert [
            event["collaboration"]
            for event in payloads
            if event.get("type") == "agent.collaboration"
        ] == [collaboration_payload]
        assert any(event.get("type") == "session.completed" for event in payloads)


def test_cancel_command_is_redelivered_until_run_termination_confirms_it(
    monkeypatch,
) -> None:
    monkeypatch.setenv("RELAY_ADMIN_TOKEN", "admin_token")
    with TemporaryDirectory() as root:
        app = create_app(root)
        client = TestClient(app)
        _bootstrap_admin(client)
        _login_admin(client)
        response = client.post(
            "/api/v1/daemon-node-registrations",
            json={
                "sandboxId": "sbx_alice",
                "employeeId": "alice",
                "token": "node_token",
                "workspacePath": "/workspace/alice",
                "protocolVersion": 1,
                "supportedAgents": ["codex"],
                "capabilities": ["thread-workspaces"],
                "status": "ready",
            },
            headers={"Authorization": "Bearer ui_token"},
        )
        assert response.status_code == 200

        run = client.post(
            "/api/v1/sandboxes/sbx_alice/runs",
            json={
                "taskGoal": "cancel this run reliably",
                "assignments": [{"agent": "codex"}],
            },
            headers={"Authorization": "Bearer ui_token"},
        )
        assert run.status_code == 202
        session_id = run.json()["id"]
        [start] = client.get(
            "/api/v1/daemon-nodes/sbx_alice/commands?leaseMode=explicit&leaseSeconds=1",
            headers={"Authorization": "Bearer node_token"},
        ).json()["commands"]

        cancel = client.post(
            f"/api/v1/threads/{session_id}/cancellations",
            json={"reason": "no longer needed"},
            headers={"Authorization": "Bearer ui_token"},
        )
        assert cancel.status_code == 202
        poll_url = (
            "/api/v1/daemon-nodes/sbx_alice/commands"
            f"?leaseMode=explicit&leaseSeconds=1&activeCommandLease={start['id']}:{start['leaseId']}"
        )
        [first_cancel] = client.get(
            poll_url,
            headers={"Authorization": "Bearer node_token"},
        ).json()["commands"]
        assert first_cancel["type"] == "run.cancel"
        assert first_cancel["attempt"] == 1

        time.sleep(1.05)

        [second_cancel] = client.get(
            poll_url,
            headers={"Authorization": "Bearer node_token"},
        ).json()["commands"]
        assert second_cancel["id"] == first_cancel["id"]
        assert second_cancel["attempt"] == 2

        terminal = client.post(
            "/api/v1/daemon-nodes/sbx_alice/events",
            json={
                "type": "run.cancelled",
                "commandId": start["id"],
                "leaseId": start["leaseId"],
                "sessionId": start["sessionId"],
                "runId": start["runId"],
                "agent": start["agent"],                "reason": "no longer needed",
            },
            headers={"Authorization": "Bearer node_token"},
        )
        assert terminal.status_code == 200

        after_terminal = client.get(
            "/api/v1/daemon-nodes/sbx_alice/commands?leaseMode=explicit&leaseSeconds=1",
            headers={"Authorization": "Bearer node_token"},
        )
        assert after_terminal.status_code == 200
        assert after_terminal.json() == {"commands": []}


def test_session_cancel_uses_durable_run_when_node_monitor_is_stale(
    monkeypatch,
) -> None:
    monkeypatch.setenv("RELAY_ADMIN_TOKEN", "admin_token")
    with TemporaryDirectory() as root:
        app = create_app(root)
        client = TestClient(app)
        _bootstrap_admin(client)
        _login_admin(client)
        response = client.post(
            "/api/v1/daemon-node-registrations",
            json={
                "sandboxId": "sbx_alice",
                "employeeId": "alice",
                "token": "node_token",
                "workspacePath": "/workspace/alice",
                "protocolVersion": 1,
                "supportedAgents": ["codex"],
                "capabilities": ["thread-workspaces"],
                "status": "ready",
            },
            headers={"Authorization": "Bearer ui_token"},
        )
        assert response.status_code == 200

        run = client.post(
            "/api/v1/sandboxes/sbx_alice/runs",
            json={
                "taskGoal": "stop while the monitor snapshot is stale",
                "assignments": [{"agent": "codex"}],
            },
            headers={"Authorization": "Bearer ui_token"},
        )
        assert run.status_code == 202
        session_id = run.json()["id"]
        [start] = client.get(
            "/api/v1/daemon-nodes/sbx_alice/commands"
            "?leaseMode=explicit&leaseSeconds=10",
            headers={"Authorization": "Bearer node_token"},
        ).json()["commands"]

        monitored = app.state.registry.monitor_nodes
        monkeypatch.setattr(
            app.state.registry,
            "monitor_nodes",
            lambda: [{**node, "activeRuns": []} for node in monitored()],
        )

        cancel = client.post(
            f"/api/v1/threads/{session_id}/cancellations",
            json={"reason": "stop clicked"},
        )

        assert cancel.status_code == 202
        [command] = client.get(
            "/api/v1/daemon-nodes/sbx_alice/commands"
            f"?leaseMode=explicit&leaseSeconds=10&activeCommandLease={start['id']}:{start['leaseId']}",
            headers={"Authorization": "Bearer node_token"},
        ).json()["commands"]
        assert command["type"] == "run.cancel"
        assert command["sessionId"] == session_id


def test_cancel_returns_terminal_session_when_run_finishes_before_request(
    monkeypatch,
) -> None:
    monkeypatch.setenv("RELAY_ADMIN_TOKEN", "admin_token")
    with TemporaryDirectory() as root:
        app = create_app(root)
        client = TestClient(app)
        _bootstrap_admin(client)
        _login_admin(client)
        response = client.post(
            "/api/v1/daemon-node-registrations",
            json={
                "sandboxId": "sbx_alice",
                "employeeId": "alice",
                "token": "node_token",
                "workspacePath": "/workspace/alice",
                "protocolVersion": 1,
                "supportedAgents": ["codex"],
                "capabilities": ["thread-workspaces"],
                "status": "ready",
            },
            headers={"Authorization": "Bearer ui_token"},
        )
        assert response.status_code == 200

        run = client.post(
            "/api/v1/sandboxes/sbx_alice/runs",
            json={
                "taskGoal": "finish before stop click",
                "assignments": [{"agent": "codex"}],
            },
            headers={"Authorization": "Bearer ui_token"},
        )
        assert run.status_code == 202
        session_id = run.json()["id"]
        [command] = client.get(
            "/api/v1/daemon-nodes/sbx_alice/commands?leaseMode=explicit&leaseSeconds=10",
            headers={"Authorization": "Bearer node_token"},
        ).json()["commands"]
        completed = client.post(
            "/api/v1/daemon-nodes/sbx_alice/events",
            json={
                "type": "run.completed",
                "commandId": command["id"],
                "leaseId": command["leaseId"],
                "sessionId": session_id,
                "runId": command["runId"],
                "agent": command["agent"],                "exitCode": 0,
                "agentLog": "done",
            },
            headers={"Authorization": "Bearer node_token"},
        )
        assert completed.status_code == 200

        cancel = client.post(
            f"/api/v1/threads/{session_id}/cancellations",
            json={"reason": "stop clicked"},
            headers={"Authorization": "Bearer ui_token"},
        )

        assert cancel.status_code == 202
        assert cancel.json()["status"] == "completed"


def test_cancel_marks_orphaned_running_session_cancelled(monkeypatch) -> None:
    monkeypatch.setenv("RELAY_ADMIN_TOKEN", "admin_token")
    with TemporaryDirectory() as root:
        app = create_app(root)
        client = TestClient(app)
        _bootstrap_admin(client)
        _login_admin(client)
        session = SessionController(app.state.registry.store).create_session(
            "stop an orphaned conversation"
        )

        cancel = client.post(
            f"/api/v1/threads/{session['id']}/cancellations",
            json={"reason": "stop clicked"},
        )

        assert cancel.status_code == 202
        assert cancel.json()["status"] == "cancelled"


def test_daemon_registration_stores_agent_health_and_rejects_unready_runs(
    monkeypatch,
) -> None:
    monkeypatch.setenv("RELAY_ADMIN_TOKEN", "admin_token")
    with TemporaryDirectory() as root:
        app = create_app(root)
        client = TestClient(app)
        _bootstrap_admin(client)
        _login_admin(client)

        response = client.post(
            "/api/v1/daemon-node-registrations",
            json={
                "sandboxId": "sbx_alice",
                "employeeId": "alice",
                "token": "node_token",
                "workspacePath": "/workspace/alice",
                "protocolVersion": 1,
                "supportedAgents": ["codex"],
                "capabilities": ["thread-workspaces"],
                "agentHealth": {
                    "codex": {
                        "status": "ready",
                        "detail": "Codex preflight passed.",
                        "adapter": "cli",
                    },
                    "kimi": {
                        "status": "failed",
                        "detail": "Kimi is not logged in.",
                        "adapter": "cli",
                    },
                },
                "status": "ready",
            },
            headers={"Authorization": "Bearer ui_token"},
        )

        assert response.status_code == 200
        body = response.json()
        assert body["agents"]["codex"] == "ready"
        assert body["agents"]["kimi"] == "failed"
        assert body["agentDetails"]["kimi"]["detail"] == "Kimi is not logged in."

        public = client.get(
            "/api/v1/daemon-nodes", headers={"Authorization": "Bearer ui_token"}
        )
        assert public.status_code == 200
        public_node = public.json()["nodes"][0]
        assert public_node["agentDetails"]["kimi"]["adapter"] == "cli"
        assert "nodeToken" not in public_node

        admin = client.get("/api/v1/admin/daemon-nodes")
        assert admin.status_code == 200
        assert admin.json()["nodes"][0]["nodeToken"] == "node_token"

        run = client.post(
            "/api/v1/sandboxes/sbx_alice/runs",
            json={
                "taskGoal": "try kimi",
                "assignments": [{"agent": "kimi"}],
            },
            headers={"Authorization": "Bearer ui_token"},
        )
        assert run.status_code == 409
        assert "does not have ready agent" in run.json()["detail"]


def test_admin_creates_employee_login_and_assigns_unassigned_node(monkeypatch) -> None:
    monkeypatch.setenv("RELAY_ADMIN_TOKEN", "admin_token")
    with TemporaryDirectory() as root:
        app = create_app(root)
        client = TestClient(app)
        _bootstrap_admin(client)
        _login_admin(client)

        response = client.post(
            "/api/v1/daemon-node-registrations",
            json={
                "sandboxId": "sbx_unassigned",
                "token": "node_token",
                "workspacePath": "/workspace/unassigned",
                "protocolVersion": 1,
                "supportedAgents": ["claude", "codex"],
                "capabilities": ["thread-workspaces"],
                "status": "ready",
            },
            headers={"Authorization": "Bearer ui_token"},
        )
        assert response.status_code == 200
        assert "employeeId" not in response.json()

        response = client.get("/api/v1/admin/daemon-nodes")
        assert response.status_code == 200
        assert "employeeId" not in response.json()["nodes"][0]

        response = client.post(
            "/api/v1/admin/employees",
            json={
                "employeeId": "alice",
                "username": "alice",
                "password": "userpass",
                "email": "alice@example.com",
                "displayName": "Alice",
                "nodeId": "sbx_unassigned",
            },
        )
        assert response.status_code == 201
        body = response.json()
        assert body["user"]["username"] == "alice"
        assert body["user"]["role"] == "user"
        assert body["user"]["employeeId"] == "alice"
        assert body["employee"]["id"] == "alice"
        assert body["employee"]["displayName"] == "Alice"
        assert body["node"]["id"] == "sbx_unassigned"
        assert body["node"]["employeeId"] == "alice"

        poll = client.get(
            "/api/v1/daemon-nodes/sbx_unassigned/commands",
            headers={"Authorization": "Bearer node_token"},
        )
        assert poll.status_code == 200
        assert poll.json() == {"commands": []}

        alice_client = TestClient(app)
        login = alice_client.post(
            "/api/v1/auth/login", json={"username": "alice", "password": "userpass"}
        )
        assert login.status_code == 200
        assert login.json()["user"]["employeeId"] == "alice"


def test_admin_assigns_unassigned_node_to_existing_employee(monkeypatch) -> None:
    monkeypatch.setenv("RELAY_ADMIN_TOKEN", "admin_token")
    with TemporaryDirectory() as root:
        app = create_app(root)
        client = TestClient(app)
        _bootstrap_admin(client)
        _login_admin(client)

        created = client.post(
            "/api/v1/admin/users",
            json={
                "username": "alice",
                "password": "userpass",
                "role": "user",
                "employeeId": "alice",
            },
        )
        assert created.status_code == 201

        registered = client.post(
            "/api/v1/daemon-node-registrations",
            json={
                "sandboxId": "node_unassigned",
                "token": "node_token",
                "workspacePath": "/workspace/unassigned",
                "protocolVersion": 1,
                "supportedAgents": ["claude", "codex"],
                "capabilities": ["thread-workspaces"],
                "status": "ready",
            },
        )
        assert registered.status_code == 200
        assert "employeeId" not in registered.json()

        assigned = client.put(
            "/api/v1/admin/daemon-nodes/node_unassigned/assignment",
            json={"employeeId": "alice"},
        )
        assert assigned.status_code == 200
        body = assigned.json()
        assert body["employee"]["id"] == "alice"
        assert body["node"]["id"] == "node_unassigned"
        assert body["node"]["employeeId"] == "alice"
        assert body["node"]["nodeLocation"] == "employee-device"

        listing = client.get("/api/v1/admin/daemon-nodes")
        assert listing.status_code == 200
        listed = next(
            node for node in listing.json()["nodes"] if node["id"] == "node_unassigned"
        )
        assert listed["nodeLocation"] == "employee-device"

        restarted = TestClient(create_app(root))
        _login_admin(restarted)
        restarted_listing = restarted.get("/api/v1/admin/daemon-nodes")
        assert restarted_listing.status_code == 200
        restarted_node = next(
            node
            for node in restarted_listing.json()["nodes"]
            if node["id"] == "node_unassigned"
        )
        assert restarted_node["nodeLocation"] == "employee-device"

        second = client.put(
            "/api/v1/admin/daemon-nodes/node_unassigned/assignment",
            json={"employeeId": "alice"},
        )
        assert second.status_code == 409


def test_create_employee_rejects_invalid_node_assignment(monkeypatch) -> None:
    monkeypatch.setenv("RELAY_ADMIN_TOKEN", "admin_token")
    with TemporaryDirectory() as root:
        client = TestClient(create_app(root))
        _bootstrap_admin(client)
        _login_admin(client)

        # Node assignment is optional: onboarding without a nodeId creates only
        # the employee/user record. Nodes are managed separately.
        without_node = client.post(
            "/api/v1/admin/employees",
            json={
                "employeeId": "nodeless",
                "username": "nodeless",
                "password": "userpass",
            },
        )
        assert without_node.status_code == 201
        without_node_body = without_node.json()
        assert without_node_body["employee"]["id"] == "nodeless"
        assert "node" not in without_node_body

        missing_node = client.post(
            "/api/v1/admin/employees",
            json={
                "employeeId": "alice",
                "username": "alice",
                "password": "userpass",
                "nodeId": "sbx_missing",
            },
        )
        assert missing_node.status_code == 404

        client.post(
            "/api/v1/daemon-node-registrations",
            json={
                "sandboxId": "sbx_unassigned",
                "token": "node_token",
                "protocolVersion": 1,
                "supportedAgents": ["claude"],
                "capabilities": ["thread-workspaces"],
                "status": "ready",
            },
        )
        first = client.post(
            "/api/v1/admin/employees",
            json={
                "employeeId": "alice",
                "username": "alice",
                "password": "userpass",
                "nodeId": "sbx_unassigned",
            },
        )
        assert first.status_code == 201

        client.post(
            "/api/v1/daemon-node-registrations",
            json={
                "sandboxId": "sbx_second",
                "token": "node_token_2",
                "protocolVersion": 1,
                "supportedAgents": ["claude"],
                "capabilities": ["thread-workspaces"],
                "status": "ready",
            },
        )
        duplicate_user = client.post(
            "/api/v1/admin/employees",
            json={
                "employeeId": "bob",
                "username": "alice",
                "password": "userpass",
                "nodeId": "sbx_second",
            },
        )
        assert duplicate_user.status_code == 409

        already_assigned = client.post(
            "/api/v1/admin/employees",
            json={
                "employeeId": "carol",
                "username": "carol",
                "password": "userpass",
                "nodeId": "sbx_unassigned",
            },
        )
        assert already_assigned.status_code == 409


def test_control_panel_requires_admin_session(monkeypatch) -> None:
    monkeypatch.setenv("RELAY_ADMIN_TOKEN", "admin_token")
    with TemporaryDirectory() as root:
        client = TestClient(create_app(root))

        response = client.get("/api/v1/admin/daemon-nodes")
        assert response.status_code == 401
        assert response.json()["detail"] == "Authentication required."

        _bootstrap_admin(client)
        # Bootstrap also signs the admin in, so the admin console is now accessible.
        response = client.get("/api/v1/admin/daemon-nodes")
        assert response.status_code == 200

        # After logout the admin console requires authentication again.
        response = client.post("/api/v1/auth/logout")
        assert response.status_code == 200

        response = client.get("/api/v1/admin/daemon-nodes")
        assert response.status_code == 401

        _login_admin(client)
        response = client.get("/api/v1/admin/daemon-nodes")
        assert response.status_code == 200


def test_control_panel_accepts_admin_bearer_token_for_supervisor(monkeypatch) -> None:
    monkeypatch.setenv("RELAY_ADMIN_TOKEN", "admin_token")
    with TemporaryDirectory() as root:
        client = TestClient(create_app(root))
        _bootstrap_admin(client)
        response = client.get(
            "/api/v1/admin/employees", headers={"Authorization": "Bearer admin_token"}
        )
        assert response.status_code == 200

        created = client.post(
            "/api/v1/admin/users",
            json={
                "username": "alice",
                "password": "userpass",
                "role": "user",
                "employeeId": "alice",
            },
            headers={"Authorization": "Bearer admin_token"},
        )
        assert created.status_code == 201
        body = created.json()
        assert body["user"]["employeeId"] == "alice"
        assert "node" not in body


def test_control_panel_creates_pending_daemon_node_and_reuses_duplicate(
    monkeypatch,
) -> None:
    monkeypatch.setenv("RELAY_ADMIN_TOKEN", "admin_token")
    with TemporaryDirectory() as root:
        client = TestClient(create_app(root))
        _bootstrap_admin(client)
        _login_admin(client)

        response = client.post(
            "/api/v1/admin/daemon-nodes",
            json={
                "employeeId": "alice",
                "workspacePath": "/workspace/alice",
            },
        )

        assert response.status_code == 201
        body = response.json()
        node = body["node"]
        assert node["employeeId"] == "alice"
        assert node["workspacePath"] == "/workspace/alice"
        assert node["sandboxMode"] == "boxlite"
        assert node["status"] == "provisioning"
        assert body["sandboxToken"].startswith("tok_")
        assert body["nodeToken"].startswith("tok_")
        assert body["nodeToken"] not in body["daemonCommand"]
        # Managed (boxlite) is the default sandbox mode for generated commands.
        assert "--sandbox boxlite" in body["daemonCommand"]
        assert "--use-local-agent-home" not in body["daemonCommand"]
        assert "--workspace /workspace/alice" in body["daemonCommand"]
        assert body["daemonEnv"]["RELAY_SANDBOX_ID"] == node["id"]
        assert body["daemonEnv"]["RELAY_EMPLOYEE_ID"] == "alice"
        assert body["daemonEnv"]["RELAY_DAEMON_NODE_TOKEN"] == body["nodeToken"]
        assert body["daemonEnv"]["RELAY_SANDBOX_MODE"] == "boxlite"
        assert body["daemonEnv"]["RELAY_WORKSPACE"] == "/workspace/alice"
        assert "RELAY_USE_LOCAL_AGENT_HOME" not in body["daemonEnv"]

        listing = client.get("/api/v1/admin/daemon-nodes")
        assert listing.status_code == 200
        listed = next(
            item for item in listing.json()["nodes"] if item["id"] == node["id"]
        )
        assert listed["sandboxMode"] == "boxlite"
        assert listed["displayName"] == node["id"]

        sandboxes = client.get(
            "/api/v1/sandboxes",
            headers={"Authorization": f"Bearer {body['sandboxToken']}"},
        )
        assert sandboxes.status_code == 200
        assert sandboxes.json()["sandboxes"][0]["id"] == node["id"]

        wrong_poll = client.get(
            f"/api/v1/daemon-nodes/{node['id']}/commands",
            headers={"Authorization": "Bearer wrong"},
        )
        assert wrong_poll.status_code == 401

        register = client.post(
            "/api/v1/daemon-node-registrations",
            json={
                "sandboxId": node["id"],
                "token": body["nodeToken"],
                "workspacePath": "/workspace/alice",
                "sandboxMode": "boxlite",
                "protocolVersion": 1,
                "supportedAgents": ["claude", "codex"],
                "capabilities": ["thread-workspaces"],
                "status": "ready",
            },
        )
        assert register.status_code == 200
        assert register.json()["employeeId"] == "alice"
        assert register.json()["sandboxMode"] == "boxlite"
        assert register.json()["agents"]["codex"] == "ready"

        mismatched_register = client.post(
            "/api/v1/daemon-node-registrations",
            json={
                "sandboxId": node["id"],
                "employeeId": "Alice",
                "token": body["nodeToken"],
                "workspacePath": "/workspace/alice",
                "protocolVersion": 1,
                "supportedAgents": ["claude", "codex"],
                "capabilities": ["thread-workspaces"],
                "status": "ready",
            },
        )
        assert mismatched_register.status_code == 200
        assert mismatched_register.json()["employeeId"] == "alice"

        poll = client.get(
            f"/api/v1/daemon-nodes/{node['id']}/commands",
            headers={"Authorization": f"Bearer {body['nodeToken']}"},
        )
        assert poll.status_code == 200
        assert poll.json() == {"commands": []}

        duplicate = client.post(
            "/api/v1/admin/daemon-nodes",
            json={
                "employeeId": "alice",
                "workspacePath": "/workspace/alice",
            },
        )
        assert duplicate.status_code == 201
        duplicate_body = duplicate.json()
        assert duplicate_body["node"]["id"] == node["id"]
        assert duplicate_body["node"]["sandboxMode"] == "boxlite"
        assert "sandboxToken" not in duplicate_body
        assert duplicate_body["nodeToken"] == body["nodeToken"]
        assert "daemonCommand" in duplicate_body

        unassign = client.delete(f"/api/v1/admin/daemon-nodes/{node['id']}/assignment")
        assert unassign.status_code == 200
        assert "employeeId" not in unassign.json()["node"]

        delete = client.delete(f"/api/v1/admin/daemon-nodes/{node['id']}")
        assert delete.status_code == 204

        listing = client.get("/api/v1/admin/daemon-nodes")
        assert listing.status_code == 200
        assert all(item["id"] != node["id"] for item in listing.json()["nodes"])


def test_control_panel_creates_local_mode_daemon_node(monkeypatch) -> None:
    monkeypatch.setenv("RELAY_ADMIN_TOKEN", "admin_token")
    with TemporaryDirectory() as root:
        client = TestClient(create_app(root))
        _bootstrap_admin(client)
        _login_admin(client)

        response = client.post(
            "/api/v1/admin/daemon-nodes",
            json={
                "employeeId": "alice",
                "displayName": "Alice's MacBook",
                "workspacePath": "/workspace/alice",
                "sandboxMode": "none",
                "nodeLocation": "employee-device",
            },
        )

        assert response.status_code == 201
        body = response.json()
        assert body["node"]["sandboxMode"] == "none"
        assert body["node"]["nodeLocation"] == "employee-device"
        assert body["node"]["displayName"] == "Alice's MacBook"
        assert "--sandbox none" in body["daemonCommand"]
        assert "--allow-host-agent-execution" in body["daemonCommand"]
        assert "--use-local-agent-home" in body["daemonCommand"]
        assert body["nodeToken"] not in body["daemonCommand"]
        assert body["daemonEnv"]["RELAY_SANDBOX_MODE"] == "none"
        assert body["daemonEnv"]["RELAY_ALLOW_HOST_AGENT_EXECUTION"] == "1"
        assert body["daemonEnv"]["RELAY_USE_LOCAL_AGENT_HOME"] == "1"

        listing = client.get("/api/v1/admin/daemon-nodes")
        assert listing.status_code == 200
        listed = next(
            item for item in listing.json()["nodes"] if item["id"] == body["node"]["id"]
        )
        assert listed["sandboxMode"] == "none"

        duplicate = client.post(
            "/api/v1/admin/daemon-nodes",
            json={
                "employeeId": "alice",
                "workspacePath": "/workspace/alice",
                "sandboxMode": "boxlite",
            },
        )
        assert duplicate.status_code == 201
        duplicate_body = duplicate.json()
        assert duplicate_body["node"]["id"] == body["node"]["id"]
        assert duplicate_body["node"]["sandboxMode"] == "none"
        assert "--sandbox none" in duplicate_body["daemonCommand"]
        assert "--allow-host-agent-execution" in duplicate_body["daemonCommand"]
        assert "--use-local-agent-home" in duplicate_body["daemonCommand"]
        assert duplicate_body["daemonEnv"]["RELAY_SANDBOX_MODE"] == "none"
        assert duplicate_body["daemonEnv"]["RELAY_ALLOW_HOST_AGENT_EXECUTION"] == "1"


def test_control_panel_rejects_unknown_sandbox_mode(monkeypatch) -> None:
    monkeypatch.setenv("RELAY_ADMIN_TOKEN", "admin_token")
    with TemporaryDirectory() as root:
        client = TestClient(create_app(root))
        _bootstrap_admin(client)
        _login_admin(client)

        response = client.post(
            "/api/v1/admin/daemon-nodes",
            json={
                "employeeId": "alice",
                "sandboxMode": "firecracker",
            },
        )

        assert response.status_code == 400


def test_control_panel_refuses_an_isolated_employee_device(monkeypatch) -> None:
    # `nodeLocation` and `sandboxMode` are not independent: an employee device
    # runs agents as host processes. Admin creation lands on the same
    # `provision_daemon_node` as self-service enrollment, which stores the mode
    # verbatim — so a caller asking for the pair must be refused here rather
    # than handed `--sandbox boxlite` for a laptop that cannot boot a VM.
    monkeypatch.setenv("RELAY_ADMIN_TOKEN", "admin_token")
    with TemporaryDirectory() as root:
        client = TestClient(create_app(root))
        _bootstrap_admin(client)
        _login_admin(client)

        response = client.post(
            "/api/v1/admin/daemon-nodes",
            json={
                "employeeId": "alice",
                "workspacePath": "/Users/alice/project",
                "sandboxMode": "boxlite",
                "nodeLocation": "employee-device",
            },
        )

        assert response.status_code == 400
        assert "sandboxMode" in response.json()["detail"]

        # The isolated runtime stays available to admin hardware, which is what
        # `nodeLocation` absent means.
        managed = client.post(
            "/api/v1/admin/daemon-nodes",
            json={"employeeId": "alice", "sandboxMode": "boxlite"},
        )
        assert managed.status_code == 201


def test_employee_device_node_requires_an_absolute_workspace(monkeypatch) -> None:
    monkeypatch.setenv("RELAY_ADMIN_TOKEN", "admin_token")
    with TemporaryDirectory() as root:
        client = TestClient(create_app(root))
        _bootstrap_admin(client)
        _login_admin(client)

        response = client.post(
            "/api/v1/admin/daemon-nodes",
            json={
                "employeeId": "alice",
                "workspacePath": "relative/project",
                "sandboxMode": "boxlite",
                "nodeLocation": "employee-device",
            },
        )

        assert response.status_code == 400
        assert "absolute workspacePath" in response.json()["detail"]


def test_employee_can_create_own_device_enrollment(monkeypatch) -> None:
    monkeypatch.setenv("RELAY_ADMIN_TOKEN", "admin_token")
    with TemporaryDirectory() as root:
        client = TestClient(create_app(root))
        _bootstrap_admin(client)
        _login_admin(client)
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
                "/api/v1/auth/login", json={"username": "alice", "password": "userpass"}
            ).status_code
            == 200
        )

        response = client.post(
            "/api/v1/daemon-node-enrollments/local",
            json={
                "displayName": "Travel Laptop",
                "workspacePath": "/Users/alice/project",
                "sandboxMode": "none",
            },
        )

        assert response.status_code == 201
        body = response.json()
        assert body["node"]["employeeId"] == "alice"
        assert body["node"]["nodeLocation"] == "employee-device"
        assert body["node"]["displayName"] == "Travel Laptop"
        assert body["node"]["workspacePath"] == "/Users/alice/project"
        assert "enrollmentKey" not in body["node"]
        assert body["nodeToken"] not in body["daemonCommand"]
        assert body["reused"] is False


def _enroll_employee(client: TestClient, employee_id: str) -> None:
    """Create `employee_id` and leave the client signed in as them."""
    _login_admin(client)
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
    assert client.post("/api/v1/auth/logout").status_code == 200
    assert (
        client.post(
            "/api/v1/auth/login",
            json={"username": employee_id, "password": "userpass"},
        ).status_code
        == 200
    )


def test_local_enrollment_defaults_to_direct_execution(monkeypatch) -> None:
    # A personal computer has one runtime, so an omitted field is unambiguous:
    # agents run as processes against the installs already on that machine.
    monkeypatch.setenv("RELAY_ADMIN_TOKEN", "admin_token")
    with TemporaryDirectory() as root:
        client = TestClient(create_app(root))
        _bootstrap_admin(client)
        _enroll_employee(client, "alice")

        response = client.post(
            "/api/v1/daemon-node-enrollments/local",
            json={"workspacePath": "/Users/alice/project"},
        )

        assert response.status_code == 201
        body = response.json()
        assert body["node"]["sandboxMode"] == "none"
        assert body["daemonEnv"]["RELAY_SANDBOX_MODE"] == "none"
        assert "--use-local-agent-home" in body["daemonCommand"]


def test_local_enrollment_refuses_the_isolated_runtime(monkeypatch) -> None:
    # BoxLite is provisioned on admin-owned hardware; asking an employee's own
    # laptop for it must fail loudly rather than be quietly downgraded, or the
    # start command would contradict what the caller asked for.
    monkeypatch.setenv("RELAY_ADMIN_TOKEN", "admin_token")
    with TemporaryDirectory() as root:
        client = TestClient(create_app(root))
        _bootstrap_admin(client)
        _enroll_employee(client, "alice")

        response = client.post(
            "/api/v1/daemon-node-enrollments/local",
            json={"workspacePath": "/Users/alice/project", "sandboxMode": "boxlite"},
        )

        assert response.status_code == 400
        assert "sandboxMode" in response.json()["detail"]


def test_local_enrollment_adopts_the_workspace_of_a_pathless_computer(
    monkeypatch,
) -> None:
    # `find_by_employee` treats a node with no workspacePath as matching any
    # path, so reuse used to hand back a record that never learned where the
    # employee's work lives.
    monkeypatch.setenv("RELAY_ADMIN_TOKEN", "admin_token")
    with TemporaryDirectory() as root:
        client = TestClient(create_app(root))
        _bootstrap_admin(client)
        _login_admin(client)
        created = client.post(
            "/api/v1/admin/daemon-nodes", json={"employeeId": "alice"}
        )
        assert created.status_code == 201
        assert not created.json()["node"].get("workspacePath")
        _enroll_employee(client, "alice")

        response = client.post(
            "/api/v1/daemon-node-enrollments/local",
            json={"workspacePath": "/Users/alice/project", "sandboxMode": "none"},
        )

        assert response.status_code == 201
        body = response.json()
        assert body["reused"] is True
        assert body["node"]["workspacePath"] == "/Users/alice/project"


def test_local_enrollment_returns_the_persisted_token_on_adoption(
    monkeypatch,
) -> None:
    # Launch tokens are persisted for control-panel computers, so re-enrolling
    # an already-connected computer hands back the same token — identical to
    # what the reveal endpoint answers. The command still prompts for the
    # secret instead of embedding it.
    monkeypatch.setenv("RELAY_ADMIN_TOKEN", "admin_token")
    with TemporaryDirectory() as root:
        app = create_app(root)
        client = TestClient(app)
        _bootstrap_admin(client)
        _enroll_employee(client, "alice")
        first = client.post(
            "/api/v1/daemon-node-enrollments/local",
            json={"workspacePath": "/Users/alice/project", "sandboxMode": "none"},
        )
        assert first.status_code == 201
        node_id = first.json()["node"]["id"]
        node_token = first.json()["nodeToken"]
        # Finish the enrollment: an unfinished one legitimately rotates its
        # credential, so only a computer that actually registered exercises
        # the adoption path.
        app.state.registry.register(
            {
                "sandboxId": node_id,
                "employeeId": "alice",
                "token": node_token,
                "protocolVersion": 1,
                "supportedAgents": ["codex"],
                "status": "ready",
            }
        )
        # The in-memory cache is process-local; dropping it proves the answer
        # comes from the persisted secret, not the cache.
        app.state.registry.plain_node_tokens.pop(node_id, None)

        response = client.post(
            "/api/v1/daemon-node-enrollments/local",
            json={"workspacePath": "/Users/alice/project", "sandboxMode": "none"},
        )

        assert response.status_code == 201
        body = response.json()
        assert body["reused"] is True
        assert body["node"]["id"] == node_id
        assert body["nodeToken"] == node_token
        assert body["daemonCommand"]
        assert node_id in body["daemonCommand"]
        # The command prompts for the token rather than carrying the secret.
        assert "read -rsp" in body["daemonCommand"]


def test_employee_can_disconnect_own_computer(monkeypatch) -> None:
    monkeypatch.setenv("RELAY_ADMIN_TOKEN", "admin_token")
    with TemporaryDirectory() as root:
        client = TestClient(create_app(root))
        _bootstrap_admin(client)
        _enroll_employee(client, "alice")
        enrolled = client.post(
            "/api/v1/daemon-node-enrollments/local",
            json={"workspacePath": "/Users/alice/project", "sandboxMode": "none"},
        )
        assert enrolled.status_code == 201
        node_id = enrolled.json()["node"]["id"]

        response = client.delete(f"/api/v1/daemon-nodes/{node_id}")

        assert response.status_code == 204
        listed = client.get("/api/v1/daemon-nodes")
        assert listed.status_code == 200
        assert all(node["id"] != node_id for node in listed.json()["nodes"])


def test_employee_cannot_disconnect_another_employees_computer(monkeypatch) -> None:
    monkeypatch.setenv("RELAY_ADMIN_TOKEN", "admin_token")
    with TemporaryDirectory() as root:
        client = TestClient(create_app(root))
        _bootstrap_admin(client)
        _enroll_employee(client, "alice")
        enrolled = client.post(
            "/api/v1/daemon-node-enrollments/local",
            json={"workspacePath": "/Users/alice/project", "sandboxMode": "none"},
        )
        assert enrolled.status_code == 201
        node_id = enrolled.json()["node"]["id"]
        _enroll_employee(client, "bob")

        response = client.delete(f"/api/v1/daemon-nodes/{node_id}")

        assert response.status_code == 403


def test_employee_cannot_disconnect_an_admin_managed_computer(monkeypatch) -> None:
    monkeypatch.setenv("RELAY_ADMIN_TOKEN", "admin_token")
    with TemporaryDirectory() as root:
        app = create_app(root)
        client = TestClient(app)
        _bootstrap_admin(client)
        _enroll_employee(client, "alice")
        enrolled = client.post(
            "/api/v1/daemon-node-enrollments/local",
            json={"workspacePath": "/Users/alice/project", "sandboxMode": "none"},
        )
        assert enrolled.status_code == 201
        node_id = enrolled.json()["node"]["id"]
        registry = app.state.registry
        registry.sandboxes[node_id] = {
            **registry.sandboxes[node_id],
            "managedNodeId": "managed-1",
        }

        response = client.delete(f"/api/v1/daemon-nodes/{node_id}")

        assert response.status_code == 403
        assert "managed by an admin" in response.json()["detail"]


def test_employee_can_reveal_own_computer_token(monkeypatch) -> None:
    monkeypatch.setenv("RELAY_ADMIN_TOKEN", "admin_token")
    with TemporaryDirectory() as root:
        client = TestClient(create_app(root))
        _bootstrap_admin(client)
        _enroll_employee(client, "alice")
        enrolled = client.post(
            "/api/v1/daemon-node-enrollments/local",
            json={"workspacePath": "/Users/alice/project", "sandboxMode": "none"},
        )
        assert enrolled.status_code == 201
        node_id = enrolled.json()["node"]["id"]
        node_token = enrolled.json()["nodeToken"]

        response = client.get(f"/api/v1/daemon-nodes/{node_id}/token")

        assert response.status_code == 200
        body = response.json()
        assert body["nodeToken"] == node_token
        assert body["daemonEnv"]["RELAY_DAEMON_NODE_TOKEN"] == node_token
        assert body["daemonEnv"]["RELAY_SANDBOX_ID"] == node_id
        # The start command prompts for the secret instead of embedding it.
        assert "read -rsp" in body["daemonCommand"]
        assert node_token not in body["daemonCommand"]


def test_employee_can_reveal_token_after_a_backend_restart(monkeypatch) -> None:
    # The whole point of persisting the secret: a new backend process over the
    # same data root still answers the reveal.
    monkeypatch.setenv("RELAY_ADMIN_TOKEN", "admin_token")
    with TemporaryDirectory() as root:
        first_app = create_app(root)
        client = TestClient(first_app)
        _bootstrap_admin(client)
        _enroll_employee(client, "alice")
        enrolled = client.post(
            "/api/v1/daemon-node-enrollments/local",
            json={"workspacePath": "/Users/alice/project", "sandboxMode": "none"},
        )
        assert enrolled.status_code == 201
        node_id = enrolled.json()["node"]["id"]
        node_token = enrolled.json()["nodeToken"]

        restarted = TestClient(create_app(root))
        _login_admin(restarted)
        assert (
            restarted.post(
                "/api/v1/auth/login",
                json={"username": "alice", "password": "userpass"},
            ).status_code
            == 200
        )

        response = restarted.get(f"/api/v1/daemon-nodes/{node_id}/token")

        assert response.status_code == 200
        assert response.json()["nodeToken"] == node_token


def test_employee_cannot_reveal_another_employees_token(monkeypatch) -> None:
    monkeypatch.setenv("RELAY_ADMIN_TOKEN", "admin_token")
    with TemporaryDirectory() as root:
        client = TestClient(create_app(root))
        _bootstrap_admin(client)
        _enroll_employee(client, "alice")
        enrolled = client.post(
            "/api/v1/daemon-node-enrollments/local",
            json={"workspacePath": "/Users/alice/project", "sandboxMode": "none"},
        )
        assert enrolled.status_code == 201
        node_id = enrolled.json()["node"]["id"]
        _enroll_employee(client, "bob")

        assert client.get(f"/api/v1/daemon-nodes/{node_id}/token").status_code == 403
        assert (
            client.post(
                f"/api/v1/daemon-nodes/{node_id}/token/reissue"
            ).status_code
            == 403
        )


def test_reveal_requires_authentication(monkeypatch) -> None:
    monkeypatch.setenv("RELAY_ADMIN_TOKEN", "admin_token")
    with TemporaryDirectory() as root:
        client = TestClient(create_app(root))
        _bootstrap_admin(client)
        _enroll_employee(client, "alice")
        enrolled = client.post(
            "/api/v1/daemon-node-enrollments/local",
            json={"workspacePath": "/Users/alice/project", "sandboxMode": "none"},
        )
        assert enrolled.status_code == 201
        node_id = enrolled.json()["node"]["id"]
        assert client.post("/api/v1/auth/logout").status_code == 200

        assert client.get(f"/api/v1/daemon-nodes/{node_id}/token").status_code == 401


def test_employee_can_reissue_own_computer_token(monkeypatch) -> None:
    monkeypatch.setenv("RELAY_ADMIN_TOKEN", "admin_token")
    with TemporaryDirectory() as root:
        app = create_app(root)
        client = TestClient(app)
        _bootstrap_admin(client)
        _enroll_employee(client, "alice")
        enrolled = client.post(
            "/api/v1/daemon-node-enrollments/local",
            json={"workspacePath": "/Users/alice/project", "sandboxMode": "none"},
        )
        assert enrolled.status_code == 201
        node_id = enrolled.json()["node"]["id"]
        old_token = enrolled.json()["nodeToken"]

        response = client.post(f"/api/v1/daemon-nodes/{node_id}/token/reissue")

        assert response.status_code == 200
        body = response.json()
        new_token = body["nodeToken"]
        assert new_token != old_token
        assert body["daemonEnv"]["RELAY_DAEMON_NODE_TOKEN"] == new_token
        # The reveal now answers the reissued token...
        revealed = client.get(f"/api/v1/daemon-nodes/{node_id}/token")
        assert revealed.status_code == 200
        assert revealed.json()["nodeToken"] == new_token
        # ...and the rotated-out token no longer authenticates the daemon.
        try:
            app.state.registry.register(
                {
                    "sandboxId": node_id,
                    "employeeId": "alice",
                    "token": old_token,
                    "protocolVersion": 1,
                    "supportedAgents": ["codex"],
                    "status": "ready",
                }
            )
        except PermissionError:
            pass
        else:
            raise AssertionError("rotated-out token still authenticates")


def test_reveal_without_a_recoverable_token_points_at_reissue(monkeypatch) -> None:
    # Nodes provisioned before tokens were persisted have no plaintext to
    # reveal; the answer is 409 and the way forward is a reissue.
    monkeypatch.setenv("RELAY_ADMIN_TOKEN", "admin_token")
    with TemporaryDirectory() as root:
        app = create_app(root)
        client = TestClient(app)
        _bootstrap_admin(client)
        _enroll_employee(client, "alice")
        enrolled = client.post(
            "/api/v1/daemon-node-enrollments/local",
            json={"workspacePath": "/Users/alice/project", "sandboxMode": "none"},
        )
        assert enrolled.status_code == 201
        node_id = enrolled.json()["node"]["id"]
        registry = app.state.registry
        legacy = {**registry.sandboxes[node_id]}
        legacy.pop("nodeTokenSecret", None)
        registry.sandboxes[node_id] = legacy
        registry.plain_node_tokens.pop(node_id, None)

        response = client.get(f"/api/v1/daemon-nodes/{node_id}/token")

        assert response.status_code == 409
        assert "Reissue" in response.json()["detail"]
        reissued = client.post(f"/api/v1/daemon-nodes/{node_id}/token/reissue")
        assert reissued.status_code == 200
        assert (
            client.get(f"/api/v1/daemon-nodes/{node_id}/token").json()["nodeToken"]
            == reissued.json()["nodeToken"]
        )


def test_employee_cannot_reveal_a_managed_computer_token(monkeypatch) -> None:
    monkeypatch.setenv("RELAY_ADMIN_TOKEN", "admin_token")
    with TemporaryDirectory() as root:
        app = create_app(root)
        client = TestClient(app)
        _bootstrap_admin(client)
        _enroll_employee(client, "alice")
        enrolled = client.post(
            "/api/v1/daemon-node-enrollments/local",
            json={"workspacePath": "/Users/alice/project", "sandboxMode": "none"},
        )
        assert enrolled.status_code == 201
        node_id = enrolled.json()["node"]["id"]
        registry = app.state.registry
        registry.sandboxes[node_id] = {
            **registry.sandboxes[node_id],
            "managedNodeId": "managed-1",
        }

        assert client.get(f"/api/v1/daemon-nodes/{node_id}/token").status_code == 403
        assert (
            client.post(
                f"/api/v1/daemon-nodes/{node_id}/token/reissue"
            ).status_code
            == 403
        )


def test_disconnecting_a_computer_destroys_its_token_secret(monkeypatch) -> None:
    monkeypatch.setenv("RELAY_ADMIN_TOKEN", "admin_token")
    with TemporaryDirectory() as root:
        app = create_app(root)
        client = TestClient(app)
        _bootstrap_admin(client)
        _enroll_employee(client, "alice")
        enrolled = client.post(
            "/api/v1/daemon-node-enrollments/local",
            json={"workspacePath": "/Users/alice/project", "sandboxMode": "none"},
        )
        assert enrolled.status_code == 201
        node_id = enrolled.json()["node"]["id"]

        assert client.delete(f"/api/v1/daemon-nodes/{node_id}").status_code == 204

        stored = app.state.registry.daemon_store.get_node(node_id)
        assert stored is not None
        assert stored.get("nodeTokenSecret") is None
        assert client.get(f"/api/v1/daemon-nodes/{node_id}/token").status_code == 404
        # The secret must not leak into the audit events either.
        events_dir = app.state.registry.daemon_store.events_dir
        for path in events_dir.glob("*.json"):
            assert "nodeTokenSecret" not in path.read_text()


def test_employee_can_manage_own_computer_executors(monkeypatch) -> None:
    monkeypatch.setenv("RELAY_ADMIN_TOKEN", "admin_token")
    with TemporaryDirectory() as root:
        client = TestClient(create_app(root))
        _bootstrap_admin(client)
        _login_admin(client)
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
                "/api/v1/auth/login", json={"username": "alice", "password": "userpass"}
            ).status_code
            == 200
        )
        enrolled = client.post(
            "/api/v1/daemon-node-enrollments/local",
            json={"workspacePath": "/Users/alice/project", "sandboxMode": "none"},
        )
        assert enrolled.status_code == 201
        node_id = enrolled.json()["node"]["id"]

        response = client.patch(
            f"/api/v1/daemon-nodes/{node_id}/disabled-agents",
            json={"disabledAgents": ["codex"]},
        )

        assert response.status_code == 200
        assert response.json()["node"]["disabledAgents"] == ["codex"]


def test_employee_cannot_manage_another_employees_computer_executors(
    monkeypatch,
) -> None:
    monkeypatch.setenv("RELAY_ADMIN_TOKEN", "admin_token")
    with TemporaryDirectory() as root:
        client = TestClient(create_app(root))
        _bootstrap_admin(client)
        _login_admin(client)
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
        assert client.post("/api/v1/auth/logout").status_code == 200
        assert (
            client.post(
                "/api/v1/auth/login", json={"username": "alice", "password": "userpass"}
            ).status_code
            == 200
        )
        enrolled = client.post(
            "/api/v1/daemon-node-enrollments/local",
            json={"workspacePath": "/Users/alice/project", "sandboxMode": "none"},
        )
        assert enrolled.status_code == 201
        node_id = enrolled.json()["node"]["id"]
        assert client.post("/api/v1/auth/logout").status_code == 200
        assert (
            client.post(
                "/api/v1/auth/login", json={"username": "bob", "password": "userpass"}
            ).status_code
            == 200
        )

        response = client.patch(
            f"/api/v1/daemon-nodes/{node_id}/disabled-agents",
            json={"disabledAgents": ["codex"]},
        )

        assert response.status_code == 403


def test_admin_can_manage_any_computers_executors(monkeypatch) -> None:
    monkeypatch.setenv("RELAY_ADMIN_TOKEN", "admin_token")
    with TemporaryDirectory() as root:
        client = TestClient(create_app(root))
        _bootstrap_admin(client)
        _login_admin(client)
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
                "/api/v1/auth/login", json={"username": "alice", "password": "userpass"}
            ).status_code
            == 200
        )
        enrolled = client.post(
            "/api/v1/daemon-node-enrollments/local",
            json={"workspacePath": "/Users/alice/project", "sandboxMode": "none"},
        )
        assert enrolled.status_code == 201
        node_id = enrolled.json()["node"]["id"]
        assert client.post("/api/v1/auth/logout").status_code == 200
        _login_admin(client)

        response = client.patch(
            f"/api/v1/daemon-nodes/{node_id}/disabled-agents",
            json={"disabledAgents": ["pi"]},
        )

        assert response.status_code == 200
        assert response.json()["node"]["disabledAgents"] == ["pi"]


def test_disabled_agents_endpoint_rejects_invalid_payload(monkeypatch) -> None:
    monkeypatch.setenv("RELAY_ADMIN_TOKEN", "admin_token")
    with TemporaryDirectory() as root:
        client = TestClient(create_app(root))
        _bootstrap_admin(client)
        _login_admin(client)
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
                "/api/v1/auth/login", json={"username": "alice", "password": "userpass"}
            ).status_code
            == 200
        )
        enrolled = client.post(
            "/api/v1/daemon-node-enrollments/local",
            json={"workspacePath": "/Users/alice/project", "sandboxMode": "none"},
        )
        assert enrolled.status_code == 201
        node_id = enrolled.json()["node"]["id"]

        response = client.patch(
            f"/api/v1/daemon-nodes/{node_id}/disabled-agents",
            json={"disabledAgents": "codex"},
        )

        assert response.status_code == 400


def test_control_panel_creates_unassigned_pending_daemon_node(monkeypatch) -> None:
    monkeypatch.setenv("RELAY_ADMIN_TOKEN", "admin_token")
    with TemporaryDirectory() as root:
        client = TestClient(create_app(root))
        _bootstrap_admin(client)
        _login_admin(client)

        response = client.post(
            "/api/v1/admin/daemon-nodes",
            json={
                "workspacePath": "/workspace/shared",
            },
        )

        assert response.status_code == 201
        body = response.json()
        node = body["node"]
        assert str(UUID(node["id"])) == node["id"]
        assert "employeeId" not in node
        assert node["workspacePath"] == "/workspace/shared"
        assert node["status"] == "provisioning"
        assert "nodeLocation" not in node
        assert body["sandboxToken"].startswith("tok_")
        assert body["nodeToken"].startswith("tok_")
        assert "--employee-id" not in body["daemonCommand"]
        assert "RELAY_EMPLOYEE_ID" not in body["daemonEnv"]

        register = client.post(
            "/api/v1/daemon-node-registrations",
            json={
                "sandboxId": node["id"],
                "token": body["nodeToken"],
                "workspacePath": "/workspace/shared",
                "protocolVersion": 1,
                "supportedAgents": ["claude"],
                "capabilities": ["thread-workspaces"],
                "status": "ready",
            },
        )
        assert register.status_code == 200
        assert "employeeId" not in register.json()

        register_with_employee = client.post(
            "/api/v1/daemon-node-registrations",
            json={
                "sandboxId": node["id"],
                "employeeId": "clark",
                "token": body["nodeToken"],
                "workspacePath": "/workspace/shared",
                "protocolVersion": 1,
                "supportedAgents": ["claude"],
                "capabilities": ["thread-workspaces"],
                "status": "ready",
            },
        )
        assert register_with_employee.status_code == 200
        assert "employeeId" not in register_with_employee.json()


def test_sandbox_ui_token_can_manage_owned_sessions(monkeypatch) -> None:
    monkeypatch.setenv("RELAY_ADMIN_TOKEN", "admin_token")
    with TemporaryDirectory() as root:
        app = create_app(root)
        admin_client = TestClient(app)
        _bootstrap_admin(admin_client)
        _login_admin(admin_client)

        register = admin_client.post(
            "/api/v1/daemon-node-registrations",
            json={
                "sandboxId": "sbx_alice",
                "employeeId": "alice",
                "token": "node_token",
                "workspacePath": "/workspace/alice",
                "protocolVersion": 1,
                "supportedAgents": ["claude", "codex"],
                "capabilities": ["thread-workspaces"],
                "status": "ready",
            },
            headers={"Authorization": "Bearer ui_token"},
        )
        assert register.status_code == 200

        token_client = TestClient(app)
        headers = {"Authorization": "Bearer ui_token"}
        created = token_client.post(
            "/api/v1/threads",
            json={
                "taskGoal": "ship daemon task",
                "assignments": [{"agent": "claude"}],
                "workspacePath": "/workspace/alice",
            },
            headers=headers,
        )
        assert created.status_code == 201
        session = created.json()
        session_id = session["id"]
        assert session["ownerEmployeeId"] == "alice"

        listed = token_client.get("/api/v1/threads", headers=headers)
        assert listed.status_code == 200
        assert [item["id"] for item in listed.json()["sessions"]] == [session_id]

        opened = token_client.get(f"/api/v1/threads/{session_id}", headers=headers)
        assert opened.status_code == 200
        assert opened.json()["id"] == session_id

        approved = token_client.post(
            f"/api/v1/threads/{session_id}/decisions",
            json={
                "kind": "approve",
            },
            headers=headers,
        )
        assert approved.status_code == 200
        assert approved.json()["status"] == "running"

        handed_off = token_client.post(
            f"/api/v1/threads/{session_id}/handoffs",
            json={
                "targetAgent": "codex",
                "note": "check it",
            },
            headers=headers,
        )
        assert handed_off.status_code == 200
        assert handed_off.json()["status"] == "running"
        assert "pendingDecision" not in handed_off.json()
        assert any(
            decision["kind"] == "handoff" and decision["targetAgent"] == "codex"
            for decision in handed_off.json()["decisions"]
        )

        bob_session = admin_client.post(
            "/api/v1/threads",
            json={
                "taskGoal": "bob task",
                "ownerEmployeeId": "bob",
            },
        )
        assert bob_session.status_code == 201
        assert (
            token_client.get(
                f"/api/v1/threads/{bob_session.json()['id']}", headers=headers
            ).status_code
            == 403
        )
        node_token_headers = {"Authorization": "Bearer node_token"}
        node_token_session = token_client.post(
            "/api/v1/threads",
            json={
                "taskGoal": "node token task",
                "assignments": [{"agent": "codex"}],
                "workspacePath": "/workspace/alice",
            },
            headers=node_token_headers,
        )
        assert node_token_session.status_code == 401

        bad_token = token_client.get(
            "/api/v1/threads", headers={"Authorization": "Bearer wrong"}
        )
        assert bad_token.status_code == 401
        assert bad_token.json()["detail"] == "Invalid sandbox token."


def test_anonymous_caller_cannot_provision_employee_sandbox(monkeypatch) -> None:
    monkeypatch.setenv("RELAY_ADMIN_TOKEN", "admin_token")
    with TemporaryDirectory() as root:
        app = create_app(root)
        anonymous = TestClient(app)

        response = anonymous.post(
            "/api/v1/sandboxes",
            json={
                "employeeId": "victim",
                "nodeToken": "attacker-node-token",
                "workspacePath": "/tmp/victim",
            },
            headers={"Authorization": "Bearer attacker-ui-token"},
        )

        assert response.status_code == 401
        assert app.state.registry.monitor_nodes() == []


def test_employee_can_ask_assigned_daemon_node_without_daemon_node_token(
    monkeypatch,
) -> None:
    monkeypatch.setenv("RELAY_ADMIN_TOKEN", "admin_token")
    with TemporaryDirectory() as root:
        app = create_app(root)
        admin_client = TestClient(app)
        _bootstrap_admin(admin_client)
        _login_admin(admin_client)
        _create_user(admin_client, "alice", employee_id="alice")
        _create_user(admin_client, "bob", employee_id="bob")

        pending = admin_client.post(
            "/api/v1/admin/daemon-nodes",
            json={
                "employeeId": "alice",
                "workspacePath": "/workspace/stale",
            },
        )
        assert pending.status_code == 201
        pending_id = pending.json()["node"]["id"]

        register = admin_client.post(
            "/api/v1/daemon-node-registrations",
            json={
                "sandboxId": "sbx_alice",
                "employeeId": "alice",
                "token": "node_token",
                "workspacePath": "/workspace/alice",
                "protocolVersion": 1,
                "supportedAgents": ["codex"],
                "capabilities": ["thread-workspaces"],
                "status": "ready",
            },
            headers={"Authorization": "Bearer ui_token"},
        )
        assert register.status_code == 200

        alice_client = TestClient(app)
        _login(alice_client, "alice", "userpass")
        listed = alice_client.get("/api/v1/sandboxes")
        assert listed.status_code == 200
        assert listed.json()["sandboxes"][0]["id"] == "sbx_alice"
        assert any(
            sandbox["id"] == pending_id for sandbox in listed.json()["sandboxes"]
        )

        bob_client = TestClient(app)
        _login(bob_client, "bob", "userpass")

        provision = alice_client.post("/api/v1/sandboxes", json={"employeeId": "alice"})
        assert provision.status_code == 201
        assert provision.json()["id"] == "sbx_alice"
        assert "nodeToken" not in provision.json()

        bob_provision = bob_client.post(
            "/api/v1/sandboxes", json={"employeeId": "alice"}
        )
        assert bob_provision.status_code == 403

        run = alice_client.post(
            "/api/v1/sandboxes/sbx_alice/runs",
            json={
                "taskGoal": "answer this",
                "assignments": [{"agent": "codex"}],
            },
        )
        assert run.status_code == 202
        session_id = run.json()["id"]
        assert run.json()["ownerEmployeeId"] == "alice"
        assert run.json()["status"] == "running"

        cancel = alice_client.post(
            f"/api/v1/threads/{session_id}/cancellations",
            json={
                "reason": "test cleanup",
            },
        )
        assert cancel.status_code == 202
        ready_again = admin_client.post(
            "/api/v1/daemon-node-registrations",
            json={
                "sandboxId": "sbx_alice",
                "employeeId": "alice",
                "token": "node_token",
                "workspacePath": "/workspace/alice",
                "protocolVersion": 1,
                "supportedAgents": ["codex"],
                "capabilities": ["thread-workspaces"],
                "status": "ready",
            },
            headers={"Authorization": "Bearer ui_token"},
        )
        assert ready_again.status_code == 200

        bob_session = bob_client.post(
            "/api/v1/threads",
            json={
                "taskGoal": "bob asks alice node",
                "assignments": [{"agent": "codex"}],
                "workspacePath": "/workspace/alice",
            },
        )
        assert bob_session.status_code == 201
        bob_run = bob_client.post(
            "/api/v1/sandboxes/sbx_alice/runs",
            json={
                "taskGoal": "bob asks alice node",
                "assignments": [{"agent": "codex"}],
                "sessionId": bob_session.json()["id"],
            },
        )
        assert bob_run.status_code == 403

        alice_cancel_bob = alice_client.post(
            f"/api/v1/threads/{bob_session.json()['id']}/cancellations",
            json={
                "reason": "not alice's session",
            },
        )
        assert alice_cancel_bob.status_code == 403


def test_employee_can_name_owned_computer_and_name_survives_heartbeat(
    monkeypatch,
) -> None:
    monkeypatch.setenv("RELAY_ADMIN_TOKEN", "admin_token")
    with TemporaryDirectory() as root:
        app = create_app(root)
        admin_client = TestClient(app)
        _bootstrap_admin(admin_client)
        _login_admin(admin_client)
        _create_user(admin_client, "alice", employee_id="alice")

        registered = admin_client.post(
            "/api/v1/daemon-node-registrations",
            json={
                "sandboxId": "sbx_alice",
                "employeeId": "alice",
                "token": "node_token",
                "workspacePath": "/workspace/alice",
                "workspaceId": "mch_alice",
                "protocolVersion": 1,
                "supportedAgents": ["codex"],
                "capabilities": ["thread-workspaces"],
                "status": "ready",
            },
            headers={"Authorization": "Bearer ui_token"},
        )
        assert registered.status_code == 200

        alice_client = TestClient(app)
        _login(alice_client, "alice", "userpass")
        renamed = alice_client.patch(
            "/api/v1/daemon-nodes/sbx_alice",
            json={"displayName": "  Office Mac Studio  "},
        )

        assert renamed.status_code == 200
        renamed_node = renamed.json()["node"]
        assert renamed_node["displayName"] == "Office Mac Studio"
        assert renamed_node["online"] is True
        assert renamed_node["activeRuns"] == []
        assert renamed_node["queuedCommandCount"] == 0
        for secret_field in (
            "token",
            "tokenHash",
            "uiTokenHash",
            "nodeToken",
            "nodeTokenHash",
        ):
            assert secret_field not in renamed_node
        assert (
            alice_client.get("/api/v1/daemon-nodes").json()["nodes"][0]["displayName"]
            == "Office Mac Studio"
        )
        anonymous_client = TestClient(app)
        assert anonymous_client.get("/api/v1/daemon-nodes").status_code == 401
        assert anonymous_client.get("/api/v1/sandboxes").status_code == 401

        heartbeat = admin_client.post(
            "/api/v1/daemon-node-registrations",
            json={
                "sandboxId": "sbx_alice",
                "employeeId": "alice",
                "token": "node_token",
                "workspacePath": "/workspace/alice",
                "workspaceId": "mch_alice",
                "protocolVersion": 1,
                "supportedAgents": ["codex"],
                "capabilities": ["thread-workspaces"],
                "status": "ready",
            },
            headers={"Authorization": "Bearer ui_token"},
        )
        assert heartbeat.status_code == 200
        assert heartbeat.json()["displayName"] == "Office Mac Studio"

        replacement = admin_client.post(
            "/api/v1/daemon-node-registrations",
            json={
                "sandboxId": "sbx_alice_replacement",
                "employeeId": "alice",
                "token": "replacement_node_token",
                "workspacePath": "/workspace/another-project",
                "workspaceId": "mch_alice",
                "protocolVersion": 1,
                "supportedAgents": ["codex"],
                "capabilities": ["thread-workspaces"],
                "status": "ready",
            },
            headers={"Authorization": "Bearer replacement_ui_token"},
        )
        assert replacement.status_code == 200
        assert replacement.json()["displayName"] == "Office Mac Studio"

        restarted = TestClient(create_app(root))
        _login(restarted, "alice", "userpass")
        assert (
            restarted.get("/api/v1/daemon-nodes").json()["nodes"][0]["displayName"]
            == "Office Mac Studio"
        )


def test_computer_naming_enforces_ownership_and_validates_names(monkeypatch) -> None:
    monkeypatch.setenv("RELAY_ADMIN_TOKEN", "admin_token")
    with TemporaryDirectory() as root:
        app = create_app(root)
        admin_client = TestClient(app)
        _bootstrap_admin(admin_client)
        _login_admin(admin_client)
        _create_user(admin_client, "alice", employee_id="alice")
        _create_user(admin_client, "bob", employee_id="bob")
        for employee_id in ("alice", "bob"):
            response = admin_client.post(
                "/api/v1/daemon-node-registrations",
                json={
                    "sandboxId": f"sbx_{employee_id}",
                    "employeeId": employee_id,
                    "token": f"{employee_id}_node_token",
                    "protocolVersion": 1,
                    "supportedAgents": ["codex"],
                    "capabilities": ["thread-workspaces"],
                    "status": "ready",
                },
                headers={"Authorization": f"Bearer {employee_id}_ui_token"},
            )
            assert response.status_code == 200

        alice_client = TestClient(app)
        _login(alice_client, "alice", "userpass")
        assert (
            alice_client.patch(
                "/api/v1/daemon-nodes/sbx_bob", json={"displayName": "Not mine"}
            ).status_code
            == 403
        )
        assert {
            node["id"]
            for node in alice_client.get("/api/v1/sandboxes").json()["sandboxes"]
        } == {"sbx_alice"}
        assert (
            alice_client.patch(
                "/api/v1/daemon-nodes/sbx_alice", json={"displayName": "   "}
            ).status_code
            == 400
        )
        assert (
            alice_client.patch(
                "/api/v1/daemon-nodes/sbx_alice", json={"displayName": "Line\nbreak"}
            ).status_code
            == 400
        )
        assert (
            alice_client.patch(
                "/api/v1/daemon-nodes/sbx_alice", json={"displayName": "x" * 65}
            ).status_code
            == 400
        )
        assert (
            alice_client.patch(
                "/api/v1/daemon-nodes/sbx_alice",
                json={"displayName": "Laptop", "employeeId": "bob"},
            ).status_code
            == 400
        )

        daemon_client = TestClient(app)
        assert (
            daemon_client.patch(
                "/api/v1/daemon-nodes/sbx_alice",
                json={"displayName": "Daemon controlled"},
                headers={"Authorization": "Bearer alice_node_token"},
            ).status_code
            == 401
        )

        renamed_by_admin = admin_client.patch(
            "/api/v1/daemon-nodes/sbx_bob", json={"displayName": "Bob's laptop"}
        )
        assert renamed_by_admin.status_code == 200
        assert renamed_by_admin.json()["node"]["displayName"] == "Bob's laptop"

        assert (
            alice_client.patch(
                "/api/v1/daemon-nodes/sbx_alice", json={"displayName": "Alice's laptop"}
            ).status_code
            == 200
        )
        reset = alice_client.patch(
            "/api/v1/daemon-nodes/sbx_alice", json={"displayName": None}
        )
        assert reset.status_code == 200
        assert reset.json()["node"]["displayName"] == "sbx_alice"
        heartbeat_after_reset = admin_client.post(
            "/api/v1/daemon-node-registrations",
            json={
                "sandboxId": "sbx_alice",
                "employeeId": "alice",
                "token": "alice_node_token",
                "protocolVersion": 1,
                "supportedAgents": ["codex"],
                "capabilities": ["thread-workspaces"],
                "status": "ready",
            },
            headers={"Authorization": "Bearer alice_ui_token"},
        )
        assert heartbeat_after_reset.status_code == 200
        assert "displayName" not in heartbeat_after_reset.json()


def test_employee_renames_managed_computer_through_runtime_identity(
    monkeypatch,
) -> None:
    monkeypatch.setenv("RELAY_ADMIN_TOKEN", "admin_token")
    with TemporaryDirectory() as root:
        app = create_app(root)
        admin_client = TestClient(app)
        _bootstrap_admin(admin_client)
        _login_admin(admin_client)
        _create_user(admin_client, "alice", employee_id="alice")
        managed = admin_client.post(
            "/api/v1/admin/managed-nodes",
            json={"employeeId": "alice", "sandboxMode": "boxlite"},
        ).json()["node"]
        assert (
            admin_client.patch(
                f"/api/v1/admin/managed-nodes/{managed['id']}",
                json={"displayName": "   "},
            ).status_code
            == 400
        )
        attempt = admin_client.post(
            f"/api/v1/admin/managed-nodes/{managed['id']}/attempts"
        ).json()
        enrolled = admin_client.post(
            "/api/v1/daemon-node-enrollments",
            json={"workspacePath": "/workspace/alice"},
            headers={"Authorization": f"Enrollment {attempt['enrollmentCredential']}"},
        ).json()
        registered = admin_client.post(
            "/api/v1/daemon-node-registrations",
            json={
                "sandboxId": enrolled["sandboxId"],
                "token": enrolled["token"],
                "workspacePath": "/workspace/alice",
                "protocolVersion": 1,
                "supportedAgents": ["codex"],
                "capabilities": ["thread-workspaces"],
                "status": "ready",
            },
        )
        assert registered.status_code == 200

        alice_client = TestClient(app)
        _login(alice_client, "alice", "userpass")
        renamed = alice_client.patch(
            f"/api/v1/daemon-nodes/{enrolled['sandboxId']}",
            json={"displayName": "Relay Cloud"},
        )

        assert renamed.status_code == 200
        assert renamed.json()["node"]["displayName"] == "Relay Cloud"
        assert (
            app.state.managed_node_store.get_node(managed["id"])["displayName"]
            == "Relay Cloud"
        )
        assert (
            alice_client.get("/api/v1/daemon-nodes").json()["nodes"][0]["displayName"]
            == "Relay Cloud"
        )
        assert (
            alice_client.get("/api/v1/sandboxes").json()["sandboxes"][0]["displayName"]
            == "Relay Cloud"
        )
        assert (
            admin_client.get("/api/v1/admin/daemon-nodes").json()["nodes"][0][
                "displayName"
            ]
            == "Relay Cloud"
        )

        reset = alice_client.patch(
            f"/api/v1/daemon-nodes/{enrolled['sandboxId']}",
            json={"displayName": None},
        )
        assert reset.status_code == 200
        assert reset.json()["node"]["displayName"] == managed["id"]
        assert (
            app.state.managed_node_store.get_node(managed["id"])["displayName"]
            == managed["id"]
        )

        renamed_again = admin_client.patch(
            f"/api/v1/admin/managed-nodes/{managed['id']}",
            json={"displayName": "Cloud workstation"},
        )
        assert renamed_again.status_code == 200
        direct_reset = admin_client.patch(
            f"/api/v1/admin/managed-nodes/{managed['id']}",
            json={"displayName": None},
        )
        assert direct_reset.status_code == 200
        assert direct_reset.json()["node"]["displayName"] == managed["id"]


def test_sandbox_run_accepts_decision_metadata(monkeypatch) -> None:
    monkeypatch.setenv("RELAY_ADMIN_TOKEN", "admin_token")
    with TemporaryDirectory() as root:
        app = create_app(root)
        admin_client = TestClient(app)
        _bootstrap_admin(admin_client)
        _login_admin(admin_client)
        _create_user(admin_client, "alice", employee_id="alice")

        register = admin_client.post(
            "/api/v1/daemon-node-registrations",
            json={
                "sandboxId": "sbx_alice",
                "employeeId": "alice",
                "token": "node_token",
                "workspacePath": "/workspace/alice",
                "protocolVersion": 1,
                "supportedAgents": ["codex"],
                "capabilities": ["thread-workspaces"],
                "status": "ready",
            },
            headers={"Authorization": "Bearer ui_token"},
        )
        assert register.status_code == 200

        alice_client = TestClient(app)
        _login(alice_client, "alice", "userpass")
        created = alice_client.post(
            "/api/v1/threads",
            json={
                "taskGoal": "fix auth",
                "workspacePath": "/workspace/alice",
            },
        )
        assert created.status_code == 201

        run = alice_client.post(
            "/api/v1/sandboxes/sbx_alice/runs",
            json={
                "taskGoal": "fix auth",
                "assignments": [{"agent": "codex"}],
                "sessionId": created.json()["id"],
                "decision": {"kind": "rerun", "targetAgent": "codex"},
            },
        )

        assert run.status_code == 202
        assert run.json()["decisions"][0]["kind"] == "rerun"
        assert run.json()["decisions"][0]["targetAgent"] == "codex"


def test_sandbox_run_accepts_fresh_new_conversation_payload(monkeypatch) -> None:
    monkeypatch.setenv("RELAY_ADMIN_TOKEN", "admin_token")
    with TemporaryDirectory() as root:
        app = create_app(root)
        admin_client = TestClient(app)
        _bootstrap_admin(admin_client)
        _login_admin(admin_client)
        _create_user(admin_client, "alice", employee_id="alice")

        register = admin_client.post(
            "/api/v1/daemon-node-registrations",
            json={
                "sandboxId": "sbx_alice",
                "employeeId": "alice",
                "token": "node_token",
                "workspacePath": "/workspace/alice",
                "protocolVersion": 1,
                "supportedAgents": ["claude"],
                "capabilities": ["thread-workspaces"],
                "status": "ready",
            },
            headers={"Authorization": "Bearer ui_token"},
        )
        assert register.status_code == 200

        alice_client = TestClient(app)
        _login(alice_client, "alice", "userpass")
        run = alice_client.post(
            "/api/v1/sandboxes/sbx_alice/runs",
            json={
                "taskGoal": "start a fresh thread",
                "assignments": [{"agent": "claude"}],
            },
        )

        assert run.status_code == 202
        assert run.json()["taskGoal"] == "start a fresh thread"
        assert run.json()["ownerEmployeeId"] == "alice"


def test_admin_can_start_existing_employee_session_on_employee_daemon_node(
    monkeypatch,
) -> None:
    monkeypatch.setenv("RELAY_ADMIN_TOKEN", "admin_token")
    with TemporaryDirectory() as root:
        app = create_app(root)
        admin_client = TestClient(app)
        _bootstrap_admin(admin_client)
        _login_admin(admin_client)
        _create_user(admin_client, "alice", employee_id="alice")
        _create_user(admin_client, "bob", employee_id="bob")

        register = admin_client.post(
            "/api/v1/daemon-node-registrations",
            json={
                "sandboxId": "sbx_alice",
                "employeeId": "alice",
                "token": "node_token",
                "workspacePath": "/workspace/alice",
                "protocolVersion": 1,
                "supportedAgents": ["codex"],
                "capabilities": ["thread-workspaces"],
                "status": "ready",
            },
            headers={"Authorization": "Bearer ui_token"},
        )
        assert register.status_code == 200
        register_bob = admin_client.post(
            "/api/v1/daemon-node-registrations",
            json={
                "sandboxId": "sbx_bob",
                "employeeId": "bob",
                "token": "bob_node_token",
                "workspacePath": "/workspace/bob",
                "protocolVersion": 1,
                "supportedAgents": ["codex"],
                "capabilities": ["thread-workspaces"],
                "status": "ready",
            },
            headers={"Authorization": "Bearer bob_ui_token"},
        )
        assert register_bob.status_code == 200

        created = admin_client.post(
            "/api/v1/threads",
            json={
                "taskGoal": "alice asks through admin",
                "ownerEmployeeId": "alice",
                "assignments": [{"agent": "codex"}],
                "workspacePath": "/workspace/alice",
            },
        )
        assert created.status_code == 201
        session_id = created.json()["id"]
        assert created.json()["ownerEmployeeId"] == "alice"

        bob_client = TestClient(app)
        _login(bob_client, "bob", "userpass")
        denied = bob_client.post(
            "/api/v1/sandboxes/sbx_alice/runs",
            json={
                "taskGoal": "alice asks through admin",
                "assignments": [{"agent": "codex"}],
                "sessionId": session_id,
            },
        )
        assert denied.status_code == 403

        run = admin_client.post(
            "/api/v1/sandboxes/sbx_bob/runs",
            json={
                "taskGoal": "alice asks through admin",
                "assignments": [{"agent": "codex"}],
                "sessionId": session_id,
            },
        )
        assert run.status_code == 202
        assert run.json()["id"] == session_id
        assert run.json()["ownerEmployeeId"] == "alice"
        assert run.json()["status"] == "running"


def test_admin_can_soft_delete_employee_and_unassign_nodes(monkeypatch) -> None:
    monkeypatch.setenv("RELAY_ADMIN_TOKEN", "admin_token")
    with TemporaryDirectory() as root:
        app = create_app(root)
        client = TestClient(app)
        _bootstrap_admin(client)
        _login_admin(client)

        register_user = client.post(
            "/api/v1/admin/users",
            json={
                "username": "alice",
                "password": "harbor-quartz-8830",
                "employeeId": "alice",
                "displayName": "Alice",
            },
        )
        assert register_user.status_code == 201
        provision = client.post(
            "/api/v1/admin/daemon-nodes",
            json={
                "employeeId": "alice",
                "workspacePath": "/workspace/alice",
            },
        )
        assert provision.status_code == 201
        node_id = provision.json()["node"]["id"]
        # Mark the node ready with the codex runtime directly on the
        # registry (bypassing the HTTP registration route, which also runs
        # sync_node_agents and would materialize unrelated compatibility
        # agents for every executor kind — out of scope here). A
        # provisioned-but-never-registered node has no known runtimes yet,
        # so creation needs this before it can succeed.
        app.state.registry.update_status(
            node_id, {"status": "ready", "agents": {"codex": "ready"}}
        )
        agent = client.post(
            "/api/v1/admin/agents",
            json={
                "supervisorEmployeeId": "alice",
                "displayName": "Builder",
                "executorKind": "codex",
                "defaultRole": "implementer",
                "computerId": computer_id(app.state.registry.get(node_id)),
            },
        ).json()["agent"]
        # The node is now live, so creation already auto-placed the agent —
        # only fall back to an explicit placement call if it did not.
        auto_placed = app.state.agent_placement_store.list_placements(
            agent_id=agent["id"]
        )
        placement = (
            auto_placed[0]
            if auto_placed
            else client.post(
                f"/api/v1/admin/agents/{agent['id']}/placements",
                json={"daemonNodeId": node_id},
            ).json()["placement"]
        )
        team = client.post(
            "/api/v1/admin/teams",
            json={
                "ownerEmployeeId": "alice",
                "name": "Delivery",
                "leadAgentId": agent["id"],
                "memberAgentIds": [agent["id"]],
            },
        ).json()["team"]
        managed_node = client.post(
            "/api/v1/admin/managed-nodes",
            json={
                "employeeId": "alice",
                "assignmentMode": "dedicated",
                "sandboxMode": "boxlite",
            },
        ).json()["node"]
        employee_client = TestClient(app)
        assert (
            employee_client.post(
                "/api/v1/auth/login",
                json={"username": "alice", "password": "harbor-quartz-8830"},
            ).status_code
            == 200
        )

        listing = client.get("/api/v1/admin/employees")
        assert listing.status_code == 200
        assert any(item["id"] == "alice" for item in listing.json()["employees"])

        delete = client.delete("/api/v1/admin/employees/alice")
        assert delete.status_code == 200
        body = delete.json()
        assert body["employee"]["id"] == "alice"
        assert node_id in body["unassignedNodes"]
        assert body["deletedAgents"] == [agent["id"]]
        assert body["removedPlacements"] == [placement["id"]]
        assert body["deletedManagedNodes"] == [managed_node["id"]]
        assert app.state.employee_agent_store.get_agent(agent["id"])["enabled"] is False
        cleaned_team = app.state.team_store.get_team(team["id"])
        assert cleaned_team["memberAgentIds"] == []
        assert cleaned_team["leadAgentId"] is None
        assert (
            app.state.agent_placement_store.get_placement(placement["id"])[
                "desiredState"
            ]
            == "removed"
        )
        assert (
            app.state.managed_node_store.get_node(managed_node["id"])["desiredState"]
            == "deleted"
        )
        assert employee_client.get("/api/v1/auth/me").status_code == 401
        assert (
            employee_client.post(
                "/api/v1/auth/login",
                json={"username": "alice", "password": "harbor-quartz-8830"},
            ).status_code
            == 401
        )
        assert (
            client.post(
                "/api/v1/admin/agents",
                json={
                    "supervisorEmployeeId": "alice",
                    "displayName": "Orphan",
                    "executorKind": "codex", "defaultRole": "implementer",
                },
            ).status_code
            == 404
        )

        post_delete_employees = client.get("/api/v1/admin/employees")
        assert post_delete_employees.status_code == 200
        assert all(
            item["id"] != "alice" for item in post_delete_employees.json()["employees"]
        )

        nodes = client.get("/api/v1/admin/daemon-nodes")
        assert nodes.status_code == 200
        match = next(item for item in nodes.json()["nodes"] if item["id"] == node_id)
        assert "employeeId" not in match

        duplicate = client.delete("/api/v1/admin/employees/alice")
        assert duplicate.status_code == 409


def test_admin_updates_disabled_agents_for_daemon_node(monkeypatch) -> None:
    monkeypatch.setenv("RELAY_ADMIN_TOKEN", "admin_token")
    with TemporaryDirectory() as root:
        client = TestClient(create_app(root))
        _bootstrap_admin(client)
        _login_admin(client)

        provision = client.post(
            "/api/v1/admin/daemon-nodes",
            json={
                "employeeId": "alice",
                "workspacePath": "/workspace/alice",
            },
        )
        assert provision.status_code == 201
        body = provision.json()
        node_id = body["node"]["id"]

        register = client.post(
            "/api/v1/daemon-node-registrations",
            json={
                "sandboxId": node_id,
                "token": body["nodeToken"],
                "workspacePath": "/workspace/alice",
                "protocolVersion": 1,
                "supportedAgents": ["claude", "codex", "pi"],
                "capabilities": ["thread-workspaces"],
                "status": "ready",
            },
        )
        assert register.status_code == 200

        disable = client.patch(
            f"/api/v1/admin/daemon-nodes/{node_id}/disabled-agents",
            json={"disabledAgents": ["codex", "pi"]},
        )
        assert disable.status_code == 200
        assert disable.json()["node"]["disabledAgents"] == ["codex", "pi"]

        defaults = client.patch(
            f"/api/v1/admin/daemon-nodes/{node_id}/agent-role-defaults",
            json={"agentRoleDefaults": {"codex": "planner", "pi": "tester"}},
        )
        assert defaults.status_code == 200
        assert defaults.json()["node"]["agentRoleDefaults"] == {
            "codex": "planner",
            "pi": "tester",
        }

        listing = client.get("/api/v1/admin/daemon-nodes")
        assert listing.status_code == 200
        match = next(item for item in listing.json()["nodes"] if item["id"] == node_id)
        assert match["disabledAgents"] == ["codex", "pi"]
        assert match["agentRoleDefaults"] == {"codex": "planner", "pi": "tester"}

        invalid_name = client.patch(
            f"/api/v1/admin/daemon-nodes/{node_id}/disabled-agents",
            json={"disabledAgents": ["bogus"]},
        )
        assert invalid_name.status_code == 400

        invalid_shape = client.patch(
            f"/api/v1/admin/daemon-nodes/{node_id}/disabled-agents",
            json={"disabledAgents": "codex"},
        )
        assert invalid_shape.status_code == 400

        invalid_role = client.patch(
            f"/api/v1/admin/daemon-nodes/{node_id}/agent-role-defaults",
            json={"agentRoleDefaults": {"codex": "builder"}},
        )
        assert invalid_role.status_code == 400

        missing = client.patch(
            "/api/v1/admin/daemon-nodes/node_missing/disabled-agents",
            json={"disabledAgents": []},
        )
        assert missing.status_code == 404

        clear = client.patch(
            f"/api/v1/admin/daemon-nodes/{node_id}/disabled-agents",
            json={"disabledAgents": []},
        )
        assert clear.status_code == 200
        assert "disabledAgents" not in clear.json()["node"]
        clear_defaults = client.patch(
            f"/api/v1/admin/daemon-nodes/{node_id}/agent-role-defaults",
            json={"agentRoleDefaults": {}},
        )
        assert clear_defaults.status_code == 200
        assert "agentRoleDefaults" not in clear_defaults.json()["node"]


def test_employee_updates_agent_role_overrides_for_own_daemon_node(monkeypatch) -> None:
    monkeypatch.setenv("RELAY_ADMIN_TOKEN", "admin_token")
    with TemporaryDirectory() as root:
        app = create_app(root)
        admin_client = TestClient(app)
        alice_client = TestClient(app)
        bob_client = TestClient(app)
        anon_client = TestClient(app)
        _bootstrap_admin(admin_client)
        _login_admin(admin_client)
        _create_user(admin_client, "alice", employee_id="alice")
        _create_user(admin_client, "bob", employee_id="bob")
        created_node = admin_client.post(
            "/api/v1/admin/daemon-nodes", json={"employeeId": "alice"}
        )
        assert created_node.status_code == 201
        nodes = admin_client.get("/api/v1/admin/daemon-nodes").json()["nodes"]
        alice_node = next(node for node in nodes if node.get("employeeId") == "alice")

        _login(alice_client, "alice", "userpass")
        update = alice_client.patch(
            f"/api/v1/daemon-nodes/{alice_node['id']}/agent-role-overrides",
            json={"agentRoleOverrides": {"codex": "fixer", "claude": "planner"}},
        )
        assert update.status_code == 200
        assert update.json()["node"]["agentRoleOverrides"] == {
            "claude": "planner",
            "codex": "fixer",
        }

        _login(bob_client, "bob", "userpass")
        forbidden = bob_client.patch(
            f"/api/v1/daemon-nodes/{alice_node['id']}/agent-role-overrides",
            json={"agentRoleOverrides": {"codex": "tester"}},
        )
        assert forbidden.status_code == 403

        unauthenticated = anon_client.patch(
            f"/api/v1/daemon-nodes/{alice_node['id']}/agent-role-overrides",
            json={"agentRoleOverrides": {"codex": "tester"}},
        )
        assert unauthenticated.status_code == 401

        invalid = alice_client.patch(
            f"/api/v1/daemon-nodes/{alice_node['id']}/agent-role-overrides",
            json={"agentRoleOverrides": {"codex": "builder"}},
        )
        assert invalid.status_code == 400


def test_run_completed_generated_files_flow_over_http(monkeypatch) -> None:
    """The full wire path: daemon reports generated files in run.completed and
    the artifact becomes listable and downloadable, with no shared filesystem."""
    import base64

    monkeypatch.setenv("RELAY_ADMIN_TOKEN", "admin_token")
    with TemporaryDirectory() as root:
        app = create_app(root)
        client = TestClient(app)
        _bootstrap_admin(client)
        _login_admin(client)
        response = client.post(
            "/api/v1/daemon-node-registrations",
            json={
                "sandboxId": "sbx_alice",
                "employeeId": "alice",
                "token": "node_token",
                "workspacePath": "/remote/daemon/workspace",
                "protocolVersion": 1,
                "supportedAgents": ["codex"],
                "capabilities": ["generated-files", "thread-workspaces"],
                "status": "ready",
            },
            headers={"Authorization": "Bearer ui_token"},
        )
        assert response.status_code == 200
        assert response.json()["capabilities"] == [
            "generated-files",
            "thread-workspaces",
        ]

        run = client.post(
            "/api/v1/sandboxes/sbx_alice/runs",
            json={
                "taskGoal": "generate the quarterly report",
                "assignments": [{"agent": "codex"}],
            },
            headers={"Authorization": "Bearer ui_token"},
        )
        assert run.status_code == 202
        session_id = run.json()["id"]
        [command] = client.get(
            "/api/v1/daemon-nodes/sbx_alice/commands",
            headers={"Authorization": "Bearer node_token"},
        ).json()["commands"]

        response = client.post(
            "/api/v1/daemon-nodes/sbx_alice/events",
            json={
                "type": "run.completed",
                "commandId": command["id"],
                "leaseId": command.get("leaseId"),
                "sessionId": command["sessionId"],
                "runId": command["runId"],
                "agent": "codex",
                "exitCode": 0,
                "agentLog": "created q2.pdf",
                "generatedFiles": [
                    {
                        "relativePath": "reports/q2.pdf",
                        "title": "q2.pdf",
                        "bytes": 9,
                        "contentType": "application/pdf",
                        "contentBase64": base64.b64encode(b"pdf bytes").decode("ascii"),
                    },
                    {
                        "relativePath": "../escape.pdf",
                        "title": "escape.pdf",
                        "bytes": 3,
                    },
                ],
            },
            headers={"Authorization": "Bearer node_token"},
        )
        assert response.status_code == 200

        listed = client.get("/api/v1/artifacts").json()["artifacts"]
        assert [item["workspaceRelativePath"] for item in listed] == ["reports/q2.pdf"]
        assert listed[0]["sessionId"] == session_id

        download = client.get(
            f"/api/v1/threads/{session_id}/artifacts/{listed[0]['id']}"
        )
        assert download.status_code == 200
        assert download.content == b"pdf bytes"
        assert download.headers["content-type"].startswith("application/pdf")


def test_managed_node_requires_an_existing_employee(monkeypatch) -> None:
    monkeypatch.setenv("RELAY_ADMIN_TOKEN", "admin_token")
    with TemporaryDirectory() as root:
        app = create_app(root)
        client = TestClient(app)
        _bootstrap_admin(client)
        _login_admin(client)

        missing = client.post(
            "/api/v1/admin/managed-nodes",
            json={"employeeId": "ghost", "sandboxMode": "boxlite"},
        )
        assert missing.status_code == 404
        assert app.state.managed_node_store.list_nodes() == []

        _create_user(client, "alice", employee_id="alice")
        created = client.post(
            "/api/v1/admin/managed-nodes",
            json={"employeeId": "alice", "sandboxMode": "boxlite"},
        )
        assert created.status_code == 202

        reassigned = client.patch(
            f"/api/v1/admin/managed-nodes/{created.json()['node']['id']}",
            json={"employeeId": "ghost"},
        )
        assert reassigned.status_code == 404


def test_cancel_recovers_a_session_whose_run_request_is_stuck_finalizing(
    monkeypatch,
) -> None:
    """Stop must not dead-end on a run request parked outside `running`.

    ACTIVE_RUN_REQUEST_STATUSES counts `finalizing` as active, so the route
    resolves a node for it, but `list_active_runs` only reports `running` runs
    so the registry finds nothing to cancel. That combination used to raise and
    surface as a 500, leaving the thread permanently stuck at `running` with no
    way to stop it from the UI.
    """
    monkeypatch.setenv("RELAY_ADMIN_TOKEN", "admin_token")
    with TemporaryDirectory() as root:
        app = create_app(root)
        client = TestClient(app)
        _bootstrap_admin(client)
        _login_admin(client)
        registration = client.post(
            "/api/v1/daemon-node-registrations",
            json={
                "sandboxId": "sbx_alice",
                "employeeId": "alice",
                "token": "node_token",
                "workspacePath": "/workspace/alice",
                "protocolVersion": 1,
                "supportedAgents": ["codex"],
                "capabilities": ["thread-workspaces"],
                "status": "ready",
            },
            headers={"Authorization": "Bearer ui_token"},
        )
        assert registration.status_code == 200

        run = client.post(
            "/api/v1/sandboxes/sbx_alice/runs",
            json={
                "taskGoal": "stop a thread wedged in finalizing",
                "assignments": [{"agent": "codex"}],
            },
            headers={"Authorization": "Bearer ui_token"},
        )
        assert run.status_code == 202
        session_id = run.json()["id"]
        client.get(
            "/api/v1/daemon-nodes/sbx_alice/commands"
            "?leaseMode=explicit&leaseSeconds=10",
            headers={"Authorization": "Bearer node_token"},
        )

        # The request stays active-looking while no run is cancellable.
        store = app.state.registry.daemon_store
        request = store.active_run_request_for_session_any_node(session_id)
        assert request is not None
        store.update_run_request(request["id"], {"status": "finalizing"})
        monkeypatch.setattr(store, "list_active_runs", lambda node_id=None: [])
        monkeypatch.setattr(app.state.registry, "active_commands", {})

        cancel = client.post(
            f"/api/v1/threads/{session_id}/cancellations",
            json={"reason": "stop clicked"},
            headers={"Authorization": "Bearer ui_token"},
        )

        assert cancel.status_code == 202
        assert cancel.json()["status"] == "cancelled"


def _employee_device_registration(
    sandbox_id: str = "sbx_device", *, token: str = "node_token"
) -> dict[str, Any]:
    return {
        "sandboxId": sandbox_id,
        "employeeId": "alice",
        "token": token,
        "protocolVersion": 1,
        "supportedAgents": ["codex"],
        "workspaceId": "machine-1",
        "workspacePath": "/Users/alice/project",
        "status": "ready",
    }


def test_deleting_a_node_survives_the_running_daemon_reregistering(monkeypatch) -> None:
    # Deleting a node used to drop the row outright, so the daemon still
    # running on that machine re-registered seconds later and the node
    # reappeared in the control panel.
    monkeypatch.setenv("RELAY_ADMIN_TOKEN", "admin_token")
    with TemporaryDirectory() as root:
        app = create_app(root)
        client = TestClient(app)
        _bootstrap_admin(client)
        _login_admin(client)
        app.state.registry.register(_employee_device_registration())

        deleted = client.delete("/api/v1/admin/daemon-nodes/sbx_device")
        assert deleted.status_code == 204
        assert client.get("/api/v1/admin/daemon-nodes").json()["nodes"] == []

        again = client.post(
            "/api/v1/daemon-node-registrations", json=_employee_device_registration()
        )

        assert again.status_code == 410
        assert client.get("/api/v1/admin/daemon-nodes").json()["nodes"] == []


def test_deleted_node_registration_is_rejected_after_a_daemon_restart(
    monkeypatch,
) -> None:
    # A restarted daemon comes back with a fresh sandboxId, so the tombstone
    # has to match on the Computer (workspaceId), not just the node id.
    monkeypatch.setenv("RELAY_ADMIN_TOKEN", "admin_token")
    with TemporaryDirectory() as root:
        app = create_app(root)
        client = TestClient(app)
        _bootstrap_admin(client)
        _login_admin(client)
        app.state.registry.register(_employee_device_registration())
        assert client.delete("/api/v1/admin/daemon-nodes/sbx_device").status_code == 204

        restarted = client.post(
            "/api/v1/daemon-node-registrations",
            json=_employee_device_registration("sbx_device_restarted"),
        )

        assert restarted.status_code == 410
        assert client.get("/api/v1/admin/daemon-nodes").json()["nodes"] == []


def test_deleted_node_command_poll_is_terminal(monkeypatch) -> None:
    monkeypatch.setenv("RELAY_ADMIN_TOKEN", "admin_token")
    with TemporaryDirectory() as root:
        app = create_app(root)
        client = TestClient(app)
        _bootstrap_admin(client)
        _login_admin(client)
        app.state.registry.register(_employee_device_registration())
        assert client.delete("/api/v1/admin/daemon-nodes/sbx_device").status_code == 204

        polled = client.get(
            "/api/v1/daemon-nodes/sbx_device/commands",
            headers={"Authorization": "Bearer node_token"},
        )

        assert polled.status_code == 410


def test_deleted_computer_can_be_enrolled_again(monkeypatch) -> None:
    # Deletion must not brick the machine: provisioning a fresh node record
    # lets the same Computer come back.
    monkeypatch.setenv("RELAY_ADMIN_TOKEN", "admin_token")
    with TemporaryDirectory() as root:
        app = create_app(root)
        client = TestClient(app)
        _bootstrap_admin(client)
        _login_admin(client)
        app.state.registry.register(_employee_device_registration())
        assert client.delete("/api/v1/admin/daemon-nodes/sbx_device").status_code == 204

        created = client.post(
            "/api/v1/admin/daemon-nodes", json={"employeeId": "alice"}
        )
        assert created.status_code == 201
        node = created.json()["node"]
        registered = client.post(
            "/api/v1/daemon-node-registrations",
            json=_employee_device_registration(
                node["id"], token=created.json()["nodeToken"]
            ),
        )

        assert registered.status_code == 200
        assert [item["id"] for item in client.get("/api/v1/admin/daemon-nodes").json()["nodes"]] == [node["id"]]
