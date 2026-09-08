from __future__ import annotations

import asyncio
from tempfile import TemporaryDirectory

from fastapi.testclient import TestClient
from relay.app import create_app
from relay.core.computer_identity import computer_id


def _bootstrap(client: TestClient) -> None:
    assert (
        client.post(
            "/api/v1/auth/bootstrap",
            json={"token": "admin_token", "username": "admin", "password": "kestrel-vault-7719"},
        ).status_code
        == 200
    )
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


def _register_computer(
    app,
    node_id: str,
    machine_id: str,
    *,
    project_workspaces: bool = True,
    workspace_read_shared: bool = False,
) -> dict:
    return app.state.registry.register(
        {
            "sandboxId": node_id,
            "employeeId": "alice",
            "token": f"token_{node_id}",
            "protocolVersion": 1,
            "supportedAgents": ["codex", "claude"],
            "capabilities": [
                "thread-workspaces",
                *(["project-workspaces"] if project_workspaces else []),
                *(["workspace-read-shared"] if workspace_read_shared else []),
            ],
            "status": "ready",
            "workspacePath": "/workspace/relay",
            "workspaceId": machine_id,
        }
    )


def _agent(client: TestClient, app, node: dict, name: str, executor: str) -> dict:
    # Declaring an agent whose computer is already live auto-places it, so no
    # separate placement call is needed here.
    response = client.post(
        "/api/v1/admin/agents",
        json={
            "supervisorEmployeeId": "alice",
            "displayName": name,
            "executorKind": executor,
            "defaultRole": "implementer",
            "computerId": computer_id(node),
        },
    )
    assert response.status_code == 201, response.text
    return response.json()["agent"]


def _login_alice(client: TestClient) -> None:
    assert client.post("/api/v1/auth/logout").status_code == 200
    assert (
        client.post(
            "/api/v1/auth/login",
            json={"username": "alice", "password": "userpass"},
        ).status_code
        == 200
    )


def test_employee_creates_and_updates_computer_bound_project(monkeypatch) -> None:
    monkeypatch.setenv("RELAY_ADMIN_TOKEN", "admin_token")
    with TemporaryDirectory() as root:
        app = create_app(root)
        client = TestClient(app)
        _bootstrap(client)
        computer = _register_computer(app, "node_alice_a", "machine-a")
        lead = _agent(client, app, computer, "Lead", "codex")
        reviewer = _agent(client, app, computer, "Reviewer", "claude")
        _login_alice(client)

        created = client.post(
            "/api/v1/projects",
            json={
                "name": "Relay launch",
                "daemonNodeId": computer["id"],
                "leadAgentId": lead["id"],
                "members": [
                    {
                        "agentId": lead["id"],
                        "role": "planner",
                        "functionTitle": "技术负责人",
                        "responsibilities": "拆解范围并验收交付",
                    },
                    {
                        "agentId": reviewer["id"],
                        "role": "reviewer",
                        "functionTitle": "质量负责人",
                        "responsibilities": "审查风险与回归测试",
                        "instructions": "优先检查并发写入风险。",
                    },
                ],
            },
        )

        assert created.status_code == 201, created.text
        project = created.json()["project"]
        assert project["ownerEmployeeId"] == "alice"
        assert project["computerId"] == "device:alice:machine-a"
        assert project["workspaceLayout"] == "project"
        assert project["workspaceSubpath"] == f"projects/{project['id']}"
        assert project["leadAgentId"] == lead["id"]
        assert project["version"] == 1
        assert project["members"][1] == {
            "agentId": reviewer["id"],
            "role": "reviewer",
            "functionTitle": "质量负责人",
            "responsibilities": "审查风险与回归测试",
            "instructions": "优先检查并发写入风险。",
            "enabled": True,
        }

        listed = client.get("/api/v1/projects")
        assert listed.status_code == 200
        assert [item["id"] for item in listed.json()["projects"]] == [project["id"]]

        updated = client.patch(
            f"/api/v1/projects/{project['id']}",
            json={
                "name": "Relay GA",
                "expectedVersion": 1,
                "members": [
                    {
                        "agentId": lead["id"],
                        "role": "implementer",
                        "functionTitle": "交付负责人",
                        "responsibilities": "完成实现与交付",
                    }
                ],
                "leadAgentId": lead["id"],
            },
        )
        assert updated.status_code == 200, updated.text
        assert updated.json()["project"]["version"] == 2
        assert updated.json()["project"]["name"] == "Relay GA"
        assert len(updated.json()["project"]["members"]) == 1

        stale = client.patch(
            f"/api/v1/projects/{project['id']}",
            json={"name": "Stale", "expectedVersion": 1},
        )
        assert stale.status_code == 409
        assert stale.json()["detail"] == "project_version_conflict"


def test_concurrent_project_archive_maps_stale_update_to_conflict(monkeypatch) -> None:
    monkeypatch.setenv("RELAY_ADMIN_TOKEN", "admin_token")
    with TemporaryDirectory() as root:
        app = create_app(root)
        client = TestClient(app)
        _bootstrap(client)
        computer = _register_computer(app, "node_alice_a", "machine-a")
        lead = _agent(client, app, computer, "Lead", "codex")
        _login_alice(client)
        project = client.post(
            "/api/v1/projects",
            json={
                "name": "Concurrent project",
                "daemonNodeId": computer["id"],
                "leadAgentId": lead["id"],
                "members": [
                    {
                        "agentId": lead["id"],
                        "role": "planner",
                        "functionTitle": "Lead",
                        "responsibilities": "Plan",
                    }
                ],
            },
        ).json()["project"]
        original_update = app.state.project_store.update_project

        def archive_before_update(project_id, patch, *, expected_version):
            app.state.project_store.archive_project(
                project_id, expected_version=expected_version
            )
            return original_update(
                project_id, patch, expected_version=expected_version
            )

        monkeypatch.setattr(
            app.state.project_store, "update_project", archive_before_update
        )

        response = client.patch(
            f"/api/v1/projects/{project['id']}",
            json={"name": "Too late", "expectedVersion": 1},
        )

        assert response.status_code == 409
        assert response.json()["detail"] == "project_version_conflict"


def test_project_rejects_member_on_another_computer(monkeypatch) -> None:
    monkeypatch.setenv("RELAY_ADMIN_TOKEN", "admin_token")
    with TemporaryDirectory() as root:
        app = create_app(root)
        client = TestClient(app)
        _bootstrap(client)
        computer_a = _register_computer(app, "node_alice_a", "machine-a")
        computer_b = _register_computer(app, "node_alice_b", "machine-b")
        lead = _agent(client, app, computer_a, "Lead", "codex")
        remote = _agent(client, app, computer_b, "Remote reviewer", "claude")
        _login_alice(client)

        response = client.post(
            "/api/v1/projects",
            json={
                "name": "Invalid project",
                "daemonNodeId": computer_a["id"],
                "leadAgentId": lead["id"],
                "members": [
                    {
                        "agentId": lead["id"],
                        "role": "planner",
                        "functionTitle": "Lead",
                        "responsibilities": "Plan",
                    },
                    {
                        "agentId": remote["id"],
                        "role": "reviewer",
                        "functionTitle": "Reviewer",
                        "responsibilities": "Review",
                    },
                ],
            },
        )

        assert response.status_code == 400
        assert response.json()["detail"] == "project_member_computer_mismatch"


def test_project_rejects_incompatible_computer_and_inactive_agent(monkeypatch) -> None:
    monkeypatch.setenv("RELAY_ADMIN_TOKEN", "admin_token")
    with TemporaryDirectory() as root:
        app = create_app(root)
        client = TestClient(app)
        _bootstrap(client)
        legacy = _register_computer(
            app, "node_alice_legacy", "machine-legacy", project_workspaces=False
        )
        current = _register_computer(app, "node_alice_current", "machine-current")
        lead = _agent(client, app, current, "Lead", "codex")
        _login_alice(client)

        payload = {
            "name": "Guarded project",
            "leadAgentId": lead["id"],
            "members": [
                {
                    "agentId": lead["id"],
                    "role": "planner",
                    "functionTitle": "Lead",
                    "responsibilities": "Plan",
                }
            ],
        }
        unsupported = client.post(
            "/api/v1/projects",
            json={**payload, "daemonNodeId": legacy["id"]},
        )
        assert unsupported.status_code == 400
        assert unsupported.json()["detail"] == "project_workspace_unsupported"

        placement = app.state.agent_placement_store.list_placements(
            agent_id=lead["id"]
        )[0]
        app.state.agent_placement_store.update_placement(
            placement["id"], {"desiredState": "draining"}
        )
        inactive = client.post(
            "/api/v1/projects",
            json={**payload, "daemonNodeId": current["id"]},
        )
        assert inactive.status_code == 400
        assert inactive.json()["detail"] == "project_member_computer_mismatch"


def test_project_update_revalidates_legacy_placements(monkeypatch) -> None:
    """Placements recorded before they carried a stable computerId only know
    their daemon node. Updates must resolve the computer's current node (the
    way create does) or the roster of every pre-computerId project becomes
    impossible to edit — even re-saving the unchanged members used to return
    project_member_computer_mismatch."""
    monkeypatch.setenv("RELAY_ADMIN_TOKEN", "admin_token")
    with TemporaryDirectory() as root:
        app = create_app(root)
        client = TestClient(app)
        _bootstrap(client)
        computer = _register_computer(app, "node_alice_legacy_update", "machine-legacy-update")
        lead = _agent(client, app, computer, "Lead", "codex")
        _login_alice(client)

        created = client.post(
            "/api/v1/projects",
            json={
                "name": "Legacy roster",
                "daemonNodeId": computer["id"],
                "leadAgentId": lead["id"],
                "members": [
                    {
                        "agentId": lead["id"],
                        "role": "planner",
                        "functionTitle": "Lead",
                        "responsibilities": "Plan",
                    }
                ],
            },
        )
        assert created.status_code == 201, created.text
        project = created.json()["project"]

        # Placements recorded before they carried a stable computerId only
        # know their daemon node — simulate that view of the world.
        original_list = app.state.agent_placement_store.list_placements

        def legacy_list(*args, **kwargs):
            return [
                {**record, "computerId": None}
                for record in original_list(*args, **kwargs)
            ]

        monkeypatch.setattr(
            app.state.agent_placement_store, "list_placements", legacy_list
        )

        updated = client.patch(
            f"/api/v1/projects/{project['id']}",
            json={
                "expectedVersion": project["version"],
                "members": [
                    {
                        "agentId": lead["id"],
                        "role": "planner",
                        "functionTitle": "Lead",
                        "responsibilities": "Plan and coordinate",
                    }
                ],
            },
        )

        assert updated.status_code == 200, updated.text
        assert (
            updated.json()["project"]["members"][0]["responsibilities"]
            == "Plan and coordinate"
        )


def test_project_bounds_and_member_deletion_guard(monkeypatch) -> None:
    monkeypatch.setenv("RELAY_ADMIN_TOKEN", "admin_token")
    with TemporaryDirectory() as root:
        app = create_app(root)
        client = TestClient(app)
        _bootstrap(client)
        computer = _register_computer(app, "node_alice_a", "machine-a")
        lead = _agent(client, app, computer, "Lead", "codex")
        _login_alice(client)

        invalid = client.post(
            "/api/v1/projects",
            json={
                "name": "x" * 121,
                "daemonNodeId": computer["id"],
                "leadAgentId": lead["id"],
                "members": [
                    {
                        "agentId": lead["id"],
                        "role": "planner",
                        "functionTitle": "Lead",
                        "responsibilities": "Plan",
                    }
                ],
            },
        )
        assert invalid.status_code == 400

        project = client.post(
            "/api/v1/projects",
            json={
                "name": "Protected roster",
                "daemonNodeId": computer["id"],
                "leadAgentId": lead["id"],
                "members": [
                    {
                        "agentId": lead["id"],
                        "role": "planner",
                        "functionTitle": "Lead",
                        "responsibilities": "Plan",
                    }
                ],
            },
        ).json()["project"]

        incompatible = client.get(
            f"/api/v1/projects/{project['id']}/workspace/files"
        )
        assert incompatible.status_code == 503
        assert incompatible.json()["detail"] == {"reason": "placement-unavailable"}

        client.post("/api/v1/auth/logout")
        assert (
            client.post(
                "/api/v1/auth/login",
                json={"username": "admin", "password": "kestrel-vault-7719"},
            ).status_code
            == 200
        )
        blocked = client.delete(f"/api/v1/admin/agents/{lead['id']}")
        assert blocked.status_code == 409
        assert "active project" in blocked.json()["detail"]

        client.post("/api/v1/auth/logout")
        assert (
            client.post(
                "/api/v1/auth/login",
                json={"username": "alice", "password": "userpass"},
            ).status_code
            == 200
        )
        archived = client.delete(f"/api/v1/projects/{project['id']}?expectedVersion=1")
        assert archived.status_code == 200
        listed = client.get("/api/v1/projects").json()["projects"]
        assert listed[0]["archivedAt"]


def test_employee_delete_allows_archived_project_and_preserves_history(
    monkeypatch,
) -> None:
    monkeypatch.setenv("RELAY_ADMIN_TOKEN", "admin_token")
    with TemporaryDirectory() as root:
        app = create_app(root)
        client = TestClient(app)
        _bootstrap(client)
        computer = _register_computer(app, "node_alice_a", "machine-a")
        lead = _agent(client, app, computer, "Lead", "codex")
        _login_alice(client)
        project = client.post(
            "/api/v1/projects",
            json={
                "name": "Deletion guard",
                "daemonNodeId": computer["id"],
                "leadAgentId": lead["id"],
                "members": [
                    {
                        "agentId": lead["id"],
                        "role": "planner",
                        "functionTitle": "Lead",
                        "responsibilities": "Plan",
                    }
                ],
            },
        ).json()["project"]
        archived = client.delete(
            f"/api/v1/projects/{project['id']}?expectedVersion=1"
        )
        assert archived.status_code == 200, archived.text
        client.post("/api/v1/auth/logout")
        assert (
            client.post(
                "/api/v1/auth/login",
                json={"username": "admin", "password": "kestrel-vault-7719"},
            ).status_code
            == 200
        )

        deleted = client.delete("/api/v1/admin/employees/alice")

        assert deleted.status_code == 200, deleted.text
        assert (
            app.state.project_store.get_project(project["id"]).get("archivedAt")
            is not None
        )
        assert app.state.agent_store.get_agent(lead["id"]).get("deletedAt") is not None
        assert not any(
            employee["id"] == "alice"
            for employee in client.get("/api/v1/admin/employees").json()["employees"]
        )


def test_project_routes_are_owner_scoped(monkeypatch) -> None:
    monkeypatch.setenv("RELAY_ADMIN_TOKEN", "admin_token")
    with TemporaryDirectory() as root:
        app = create_app(root)
        client = TestClient(app)
        _bootstrap(client)
        computer = _register_computer(app, "node_alice_a", "machine-a")
        lead = _agent(client, app, computer, "Lead", "codex")
        _login_alice(client)
        project = client.post(
            "/api/v1/projects",
            json={
                "name": "Private",
                "daemonNodeId": computer["id"],
                "leadAgentId": lead["id"],
                "members": [
                    {
                        "agentId": lead["id"],
                        "role": "planner",
                        "functionTitle": "Lead",
                        "responsibilities": "Plan",
                    }
                ],
            },
        ).json()["project"]

        client.post("/api/v1/auth/logout")
        assert (
            client.post(
                "/api/v1/admin/employees",
                json={
                    "employeeId": "bob",
                    "username": "bob",
                    "password": "userpass",
                    "displayName": "Bob",
                },
            ).status_code
            == 401
        )
        # Create Bob as admin, then verify the employee routes do not disclose Alice.
        assert (
            client.post(
                "/api/v1/auth/login",
                json={"username": "admin", "password": "kestrel-vault-7719"},
            ).status_code
            == 200
        )
        assert (
            client.post(
                "/api/v1/admin/employees",
                json={
                    "employeeId": "bob",
                    "username": "bob",
                    "password": "userpass",
                    "displayName": "Bob",
                },
            ).status_code
            == 201
        )
        client.post("/api/v1/auth/logout")
        assert (
            client.post(
                "/api/v1/auth/login",
                json={"username": "bob", "password": "userpass"},
            ).status_code
            == 200
        )

        assert client.get("/api/v1/projects").json()["projects"] == []
        assert client.get(f"/api/v1/projects/{project['id']}").status_code == 403
        assert (
            client.get(f"/api/v1/projects/{project['id']}/workspace/files").status_code
            == 403
        )
        assert (
            client.get(f"/api/v1/workspace/brief?projectId={project['id']}").status_code
            == 403
        )
        assert (
            client.patch(
                f"/api/v1/projects/{project['id']}",
                json={"name": "Stolen", "expectedVersion": 1},
            ).status_code
            == 403
        )


def test_project_task_creates_project_scoped_thread(monkeypatch) -> None:
    monkeypatch.setenv("RELAY_ADMIN_TOKEN", "admin_token")
    with TemporaryDirectory() as root:
        app = create_app(root)
        client = TestClient(app)
        _bootstrap(client)
        computer = _register_computer(app, "node_alice_a", "machine-a")
        lead = _agent(client, app, computer, "Lead", "codex")
        _login_alice(client)
        project = client.post(
            "/api/v1/projects",
            json={
                "name": "Shared workspace",
                "daemonNodeId": computer["id"],
                "leadAgentId": lead["id"],
                "members": [
                    {
                        "agentId": lead["id"],
                        "role": "implementer",
                        "functionTitle": "Builder",
                        "responsibilities": "Build",
                    }
                ],
            },
        ).json()["project"]

        created = client.post(
            "/api/v1/tasks",
            json={
                "title": "Implement project navigation",
                "projectId": project["id"],
                "createSession": True,
            },
        )

        assert created.status_code == 201, created.text
        task = created.json()
        assert task["projectId"] == project["id"]
        assert len(task["linkedSessionIds"]) == 1
        session = client.get(f"/api/v1/threads/{task['linkedSessionIds'][0]}")
        assert session.status_code == 200, session.text
        thread = session.json()
        assert thread["projectId"] == project["id"]
        assert thread["workspaceLayout"] == "project"
        assert thread["workspaceSubpath"] == project["workspaceSubpath"]
        assert thread["computerId"] == project["computerId"]


def test_project_thread_and_task_reject_assignment_overrides(monkeypatch) -> None:
    monkeypatch.setenv("RELAY_ADMIN_TOKEN", "admin_token")
    with TemporaryDirectory() as root:
        app = create_app(root)
        client = TestClient(app)
        _bootstrap(client)
        computer = _register_computer(app, "node_alice_a", "machine-a")
        lead = _agent(client, app, computer, "Lead", "codex")
        outsider = _agent(client, app, computer, "Outsider", "claude")
        _login_alice(client)
        project = client.post(
            "/api/v1/projects",
            json={
                "name": "Fixed roster",
                "daemonNodeId": computer["id"],
                "leadAgentId": lead["id"],
                "members": [
                    {
                        "agentId": lead["id"],
                        "role": "planner",
                        "functionTitle": "Lead",
                        "responsibilities": "Plan",
                    }
                ],
            },
        ).json()["project"]
        override = [{"agent": "claude", "agentId": outsider["id"]}]

        thread = client.post(
            "/api/v1/threads",
            json={
                "taskGoal": "Bypass the roster",
                "projectId": project["id"],
                "assignments": override,
            },
        )
        task = client.post(
            "/api/v1/tasks",
            json={
                "title": "Bypass the roster",
                "projectId": project["id"],
                "createSession": True,
                "assignments": override,
            },
        )

        assert thread.status_code == 400
        assert thread.json()["detail"] == "project_assignment_override_unsupported"
        assert task.status_code == 400
        assert task.json()["detail"] == "project_assignment_override_unsupported"
        assert app.state.task_store.list_tasks() == []

        project_task = client.post(
            "/api/v1/tasks",
            json={"title": "Fixed roster task", "projectId": project["id"]},
        )
        assert project_task.status_code == 201, project_task.text
        patch_outsider = client.patch(
            f"/api/v1/tasks/{project_task.json()['id']}",
            json={"assignedAgentId": outsider["id"]},
        )
        assign_outsider = client.put(
            f"/api/v1/tasks/{project_task.json()['id']}/assignment",
            json={"agentId": outsider["id"]},
        )
        patch_team = client.patch(
            f"/api/v1/tasks/{project_task.json()['id']}",
            json={"assignedTeamId": "not-a-project-roster"},
        )
        assign_team = client.put(
            f"/api/v1/tasks/{project_task.json()['id']}/assignment",
            json={"teamId": "not-a-project-roster"},
        )
        assert patch_outsider.status_code == 400
        assert patch_outsider.json()["detail"] == "project_agent_not_member"
        assert assign_outsider.status_code == 400
        assert assign_outsider.json()["detail"] == "project_agent_not_member"
        assert patch_team.status_code == 400
        assert patch_team.json()["detail"] == "project_team_assignment_unsupported"
        assert assign_team.status_code == 400
        assert assign_team.json()["detail"] == "project_team_assignment_unsupported"


def test_project_thread_rejects_another_computer(monkeypatch) -> None:
    monkeypatch.setenv("RELAY_ADMIN_TOKEN", "admin_token")
    with TemporaryDirectory() as root:
        app = create_app(root)
        client = TestClient(app)
        _bootstrap(client)
        computer_a = _register_computer(app, "node_alice_a", "machine-a")
        computer_b = _register_computer(app, "node_alice_b", "machine-b")
        lead = _agent(client, app, computer_a, "Lead", "codex")
        _login_alice(client)
        project = client.post(
            "/api/v1/projects",
            json={
                "name": "Pinned",
                "daemonNodeId": computer_a["id"],
                "leadAgentId": lead["id"],
                "members": [
                    {
                        "agentId": lead["id"],
                        "role": "planner",
                        "functionTitle": "Lead",
                        "responsibilities": "Plan",
                    }
                ],
            },
        ).json()["project"]

        response = client.post(
            "/api/v1/threads",
            json={
                "taskGoal": "Wrong computer",
                "projectId": project["id"],
                "daemonNodeId": computer_b["id"],
            },
        )

        assert response.status_code == 409
        assert response.json()["detail"] == "project_computer_mismatch"


def test_project_task_dispatch_compiles_member_role_and_function(monkeypatch) -> None:
    monkeypatch.setenv("RELAY_ADMIN_TOKEN", "admin_token")
    with TemporaryDirectory() as root:
        app = create_app(root)
        client = TestClient(app)
        _bootstrap(client)
        computer = _register_computer(app, "node_alice_a", "machine-a")
        lead = _agent(client, app, computer, "Lead", "codex")
        reviewer = _agent(client, app, computer, "Reviewer", "claude")
        _login_alice(client)
        project = client.post(
            "/api/v1/projects",
            json={
                "name": "Dispatch roles",
                "daemonNodeId": computer["id"],
                "leadAgentId": lead["id"],
                "members": [
                    {
                        "agentId": lead["id"],
                        "role": "planner",
                        "functionTitle": "技术负责人",
                        "responsibilities": "先定义边界与实现顺序",
                        "instructions": "不要直接跳过计划阶段。",
                    },
                    {
                        "agentId": reviewer["id"],
                        "role": "reviewer",
                        "functionTitle": "质量负责人",
                        "responsibilities": "最后审查风险与回归",
                    },
                ],
            },
        ).json()["project"]
        task = client.post(
            "/api/v1/tasks",
            json={"title": "Ship project", "projectId": project["id"]},
        ).json()

        started = client.post(f"/api/v1/tasks/{task['id']}/runs", json={})

        assert started.status_code == 202, started.text
        result = started.json()
        assert result["dispatch"]["state"] == "started"
        assert result["session"]["projectId"] == project["id"]
        assert result["session"]["workspaceLayout"] == "project"
        [command] = app.state.registry.take_commands(
            computer["id"], f"token_{computer['id']}"
        )
        assert command["workspaceSubpath"] == project["workspaceSubpath"]
        assert command["logicalAgentId"] == lead["id"]
        assert command["role"] == "planner"
        assert "技术负责人" in command["state"]["assignment_brief"]
        assert "先定义边界与实现顺序" in command["state"]["assignment_brief"]
        assert "不要直接跳过计划阶段" in command["state"]["assignment_brief"]


def test_project_dispatch_fails_closed_after_incompatible_daemon_replacement(
    monkeypatch,
) -> None:
    monkeypatch.setenv("RELAY_ADMIN_TOKEN", "admin_token")
    with TemporaryDirectory() as root:
        app = create_app(root)
        client = TestClient(app)
        _bootstrap(client)
        computer = _register_computer(app, "node_alice_a", "machine-a")
        lead = _agent(client, app, computer, "Lead", "codex")
        _login_alice(client)
        project = client.post(
            "/api/v1/projects",
            json={
                "name": "Replacement guard",
                "daemonNodeId": computer["id"],
                "leadAgentId": lead["id"],
                "members": [
                    {
                        "agentId": lead["id"],
                        "role": "implementer",
                        "functionTitle": "Builder",
                        "responsibilities": "Build",
                    }
                ],
            },
        ).json()["project"]
        task = client.post(
            "/api/v1/tasks",
            json={"title": "Do not run on legacy daemon", "projectId": project["id"]},
        ).json()
        app.state.registry.register(
            {
                "sandboxId": computer["id"],
                "employeeId": "alice",
                "token": f"token_{computer['id']}",
                "protocolVersion": 1,
                "supportedAgents": ["codex", "claude"],
                "capabilities": ["thread-workspaces"],
                "status": "ready",
                "workspacePath": "/workspace/relay",
                "workspaceId": "machine-a",
            }
        )

        started = client.post(f"/api/v1/tasks/{task['id']}/runs", json={})

        assert started.status_code == 202, started.text
        assert started.json()["session"] is None
        assert started.json()["dispatch"]["state"] == "queued"
        assert started.json()["dispatch"]["code"] == "project_computer_offline"
        assert started.json()["task"]["status"] != "running"


def test_manual_project_routine_dispatches_project_roster(monkeypatch) -> None:
    monkeypatch.setenv("RELAY_ADMIN_TOKEN", "admin_token")
    with TemporaryDirectory() as root:
        app = create_app(root)
        client = TestClient(app)
        _bootstrap(client)
        computer = _register_computer(app, "node_alice_a", "machine-a")
        lead = _agent(client, app, computer, "Lead", "codex")
        _login_alice(client)
        project = client.post(
            "/api/v1/projects",
            json={
                "name": "Routine project",
                "daemonNodeId": computer["id"],
                "leadAgentId": lead["id"],
                "members": [
                    {
                        "agentId": lead["id"],
                        "role": "implementer",
                        "functionTitle": "Builder",
                        "responsibilities": "Build",
                    }
                ],
            },
        ).json()["project"]
        routine = client.post(
            "/api/v1/tasks",
            json={
                "title": "Weekly project report",
                "projectId": project["id"],
                "isRoutine": True,
                "routineCadence": "weekly",
                "routineEnabled": True,
            },
        )
        assert routine.status_code == 201, routine.text

        started = client.post(f"/api/v1/tasks/{routine.json()['id']}/runs", json={})

        assert started.status_code == 202, started.text
        assert started.json()["dispatch"]["state"] == "started"
        assert started.json()["task"]["sourceRoutineId"] == routine.json()["id"]
        assert started.json()["task"]["projectId"] == project["id"]
        assert started.json()["session"]["projectId"] == project["id"]
        [command] = app.state.registry.take_commands(
            computer["id"], f"token_{computer['id']}"
        )
        assert command["logicalAgentId"] == lead["id"]
        assert command["workspaceSubpath"] == project["workspaceSubpath"]


def test_scheduler_dispatches_assigned_project_task(monkeypatch) -> None:
    monkeypatch.setenv("RELAY_ADMIN_TOKEN", "admin_token")
    with TemporaryDirectory() as root:
        app = create_app(root)
        client = TestClient(app)
        _bootstrap(client)
        computer = _register_computer(app, "node_alice_a", "machine-a")
        lead = _agent(client, app, computer, "Lead", "codex")
        reviewer = _agent(client, app, computer, "Reviewer", "claude")
        _login_alice(client)
        project = client.post(
            "/api/v1/projects",
            json={
                "name": "Scheduled project",
                "daemonNodeId": computer["id"],
                "leadAgentId": lead["id"],
                "members": [
                    {
                        "agentId": lead["id"],
                        "role": "planner",
                        "functionTitle": "Lead",
                        "responsibilities": "Plan delivery",
                    },
                    {
                        "agentId": reviewer["id"],
                        "role": "reviewer",
                        "functionTitle": "Reviewer",
                        "responsibilities": "Review delivery",
                    },
                ],
            },
        ).json()["project"]
        task_response = client.post(
            "/api/v1/tasks",
            json={
                "title": "Scheduled project work",
                "projectId": project["id"],
                "status": "assigned",
            },
        )
        assert task_response.status_code == 201, task_response.text

        tick = asyncio.run(app.state.task_scheduler.tick())

        assert tick.dispatched == 1
        task = app.state.task_store.get_task(task_response.json()["id"])
        assert task["status"] == "running"
        session = app.state.session_store.get_session(task["linkedSessionIds"][0])
        assert session["projectId"] == project["id"]
        [command] = app.state.registry.take_commands(
            computer["id"], f"token_{computer['id']}"
        )
        assert command["workspaceLayout"] == "project"
        assert command["workspaceSubpath"] == project["workspaceSubpath"]
        assert command["logicalAgentId"] == lead["id"]
        assert command["role"] == "planner"


def test_project_room_run_expands_fixed_roster(monkeypatch) -> None:
    monkeypatch.setenv("RELAY_ADMIN_TOKEN", "admin_token")
    with TemporaryDirectory() as root:
        app = create_app(root)
        client = TestClient(app)
        _bootstrap(client)
        computer = _register_computer(app, "node_alice_a", "machine-a")
        lead = _agent(client, app, computer, "Lead", "codex")
        reviewer = _agent(client, app, computer, "Reviewer", "claude")
        _login_alice(client)
        project = client.post(
            "/api/v1/projects",
            json={
                "name": "Project room run",
                "daemonNodeId": computer["id"],
                "leadAgentId": lead["id"],
                "members": [
                    {
                        "agentId": lead["id"],
                        "role": "implementer",
                        "functionTitle": "Builder",
                        "responsibilities": "Build the change",
                    },
                    {
                        "agentId": reviewer["id"],
                        "role": "reviewer",
                        "functionTitle": "Reviewer",
                        "responsibilities": "Review the change",
                    },
                ],
            },
        ).json()["project"]

        response = client.post(
            "/api/v1/agent-runs",
            json={"taskGoal": "Deliver the feature", "projectId": project["id"]},
        )

        assert response.status_code == 202, response.text
        session = response.json()
        assert session["projectId"] == project["id"]
        assert session["participantAgentIds"] == [lead["id"], reviewer["id"]]
        manifest = session["collaborationRounds"][0]
        assert manifest["projectSnapshot"]["projectId"] == project["id"]
        assert [item["agentId"] for item in manifest["assignments"]] == [
            lead["id"],
            reviewer["id"],
        ]
        [command] = app.state.registry.take_commands(
            computer["id"], f"token_{computer['id']}"
        )
        assert command["workspaceSubpath"] == project["workspaceSubpath"]
        assert command["logicalAgentId"] == lead["id"]


def test_project_room_rejects_malformed_assignment_instead_of_running_everyone(
    monkeypatch,
) -> None:
    monkeypatch.setenv("RELAY_ADMIN_TOKEN", "admin_token")
    with TemporaryDirectory() as root:
        app = create_app(root)
        client = TestClient(app)
        _bootstrap(client)
        computer = _register_computer(app, "node_alice_a", "machine-a")
        lead = _agent(client, app, computer, "Lead", "codex")
        _login_alice(client)
        project = client.post(
            "/api/v1/projects",
            json={
                "name": "Strict room",
                "daemonNodeId": computer["id"],
                "leadAgentId": lead["id"],
                "members": [
                    {
                        "agentId": lead["id"],
                        "role": "planner",
                        "functionTitle": "Lead",
                        "responsibilities": "Plan",
                    }
                ],
            },
        ).json()["project"]

        response = client.post(
            "/api/v1/agent-runs",
            json={
                "taskGoal": "Do not fail open",
                "projectId": project["id"],
                "assignments": [{}],
            },
        )

        assert response.status_code == 400
        assert response.json()["detail"] == "project_assignment_invalid"
        assert (
            app.state.registry.take_commands(
                computer["id"], f"token_{computer['id']}"
            )
            == []
        )


def test_project_workspace_browses_persistent_root_without_thread(
    monkeypatch,
) -> None:
    monkeypatch.setenv("RELAY_ADMIN_TOKEN", "admin_token")
    with TemporaryDirectory() as root:
        app = create_app(root)
        client = TestClient(app)
        _bootstrap(client)
        computer = _register_computer(
            app,
            "node_alice_a",
            "machine-a",
            workspace_read_shared=True,
        )
        lead = _agent(client, app, computer, "Lead", "codex")
        _login_alice(client)
        project = client.post(
            "/api/v1/projects",
            json={
                "name": "Persistent room",
                "daemonNodeId": computer["id"],
                "leadAgentId": lead["id"],
                "members": [
                    {
                        "agentId": lead["id"],
                        "role": "planner",
                        "functionTitle": "Lead",
                        "responsibilities": "Plan",
                    }
                ],
            },
        ).json()["project"]
        commands: list[dict] = []

        async def dispatch(_ctx, node, command):
            assert node["id"] == computer["id"]
            commands.append(command)
            if command["type"] == "workspace.list":
                return {
                    "type": "workspace.listing",
                    "path": "notes",
                    "exists": True,
                    "entries": [
                        {
                            "name": "brief.md",
                            "path": "notes/brief.md",
                            "kind": "file",
                            "bytes": 5,
                        }
                    ],
                }
            if command["path"] == "assets/logo.png":
                return {
                    "type": "workspace.file",
                    "path": "assets/logo.png",
                    "bytes": 3,
                    "isBinary": True,
                    "truncated": True,
                    "contentBase64": "AAEC",
                }
            return {
                "type": "workspace.file",
                "path": "notes/brief.md",
                "bytes": 5,
                "isBinary": False,
                "truncated": False,
                "contentBase64": "aGVsbG8=",
            }

        monkeypatch.setattr(
            "relay.api.project_routes.dispatch_workspace_command", dispatch
        )

        listing = client.get(
            f"/api/v1/projects/{project['id']}/workspace/files?path=notes"
        )
        preview = client.get(
            f"/api/v1/projects/{project['id']}/workspace/file?path=notes/brief.md"
        )
        binary = client.get(
            f"/api/v1/projects/{project['id']}/workspace/file?path=assets/logo.png"
        )

        assert listing.status_code == 200, listing.text
        assert listing.json()["projectId"] == project["id"]
        assert listing.json()["source"] == "live"
        assert listing.json()["nodeId"] == computer["id"]
        assert listing.json()["path"] == "notes"
        assert listing.json()["entries"][0]["name"] == "brief.md"
        assert preview.status_code == 200, preview.text
        assert preview.json()["content"] == "hello"
        assert binary.status_code == 200, binary.text
        assert binary.json()["isBinary"] is True
        assert binary.json()["content"] is None
        assert binary.json()["contentBase64"] == "AAEC"
        assert binary.json()["truncated"] is True
        assert binary.json()["limitBytes"] == 256 * 1024
        assert all(isinstance(command["id"], str) and command["id"] for command in commands)
        assert [
            {key: value for key, value in command.items() if key != "id"}
            for command in commands
        ] == [
            {
                "type": "workspace.list",
                "sessionId": project["id"],
                "workspaceLayout": "project",
                "workspaceSubpath": project["workspaceSubpath"],
                "path": "notes",
            },
            {
                "type": "workspace.read",
                "sessionId": project["id"],
                "workspaceLayout": "project",
                "workspaceSubpath": project["workspaceSubpath"],
                "path": "notes/brief.md",
            },
            {
                "type": "workspace.read",
                "sessionId": project["id"],
                "workspaceLayout": "project",
                "workspaceSubpath": project["workspaceSubpath"],
                "path": "assets/logo.png",
            },
        ]


def test_project_workspace_and_brief_are_project_scoped(monkeypatch) -> None:
    monkeypatch.setenv("RELAY_ADMIN_TOKEN", "admin_token")
    with TemporaryDirectory() as root:
        app = create_app(root)
        client = TestClient(app)
        _bootstrap(client)
        computer = _register_computer(
            app,
            "node_alice_a",
            "machine-a",
            workspace_read_shared=True,
        )
        lead = _agent(client, app, computer, "Lead", "codex")
        _login_alice(client)

        def create_project(name: str) -> dict:
            return client.post(
                "/api/v1/projects",
                json={
                    "name": name,
                    "daemonNodeId": computer["id"],
                    "leadAgentId": lead["id"],
                    "members": [
                        {
                            "agentId": lead["id"],
                            "role": "planner",
                            "functionTitle": "Lead",
                            "responsibilities": "Plan",
                        }
                    ],
                },
            ).json()["project"]

        project = create_project("Scoped room")
        other = create_project("Other room")
        session = app.state.session_store.create_session(
            {
                "ownerEmployeeId": "alice",
                "taskGoal": "Scoped thread",
                "workspacePath": "/workspace/relay",
                "projectId": project["id"],
                "workspaceLayout": "project",
                "workspaceSubpath": project["workspaceSubpath"],
                "computerId": project["computerId"],
            }
        )
        app.state.session_store.create_session(
            {
                "ownerEmployeeId": "alice",
                "taskGoal": "Other thread",
                "workspacePath": "/workspace/relay",
                "projectId": other["id"],
            }
        )
        task = app.state.task_store.create_task(
            {
                "ownerEmployeeId": "alice",
                "title": "Scoped task",
                "projectId": project["id"],
                "status": "assigned",
            }
        )
        app.state.task_store.create_task(
            {
                "ownerEmployeeId": "alice",
                "title": "Other task",
                "projectId": other["id"],
                "status": "assigned",
            }
        )

        brief = client.get(f"/api/v1/workspace/brief?projectId={project['id']}")

        assert brief.status_code == 200, brief.text
        body = brief.json()
        assert body["projectId"] == project["id"]
        assert [item["id"] for item in body["sessions"]] == [session["id"]]
        assert [item["id"] for item in body["tasks"]] == [task["id"]]
        assert [node["id"] for node in body["nodes"]] == [computer["id"]]
        assert (
            client.get(
                f"/api/v1/workspace/brief?projectId={project['id']}&teamId=team-x"
            ).status_code
            == 400
        )
        assert (
            client.get(
                f"/api/v1/projects/{project['id']}/workspace/file?path=../secret"
            ).status_code
            == 400
        )
        assert (
            client.get(
                "/api/v1/projects/00000000-0000-4000-8000-000000000000/workspace/files"
            ).status_code
            == 404
        )

        # The first-class project workspace is live-only.
        app.state.registry.delete(computer["id"])
        unavailable = client.get(f"/api/v1/projects/{project['id']}/workspace/files")
        assert unavailable.status_code == 503
        assert unavailable.json()["detail"] == {"reason": "placement-unavailable"}


def test_empty_project_can_add_and_remove_its_last_member(monkeypatch) -> None:
    monkeypatch.setenv("RELAY_ADMIN_TOKEN", "admin_token")
    with TemporaryDirectory() as root:
        app = create_app(root)
        client = TestClient(app)
        _bootstrap(client)
        computer = _register_computer(app, "node_alice_empty", "machine-empty")
        lead = _agent(client, app, computer, "Lead", "codex")
        _login_alice(client)
        created = client.post("/api/v1/projects", json={
            "name": "Empty project", "daemonNodeId": computer["id"],
            "leadAgentId": None, "members": [],
        })
        assert created.status_code == 201, created.text
        project = created.json()["project"]
        assert project["leadAgentId"] is None
        member = {
            "agentId": lead["id"], "role": "planner", "functionTitle": "Lead",
            "responsibilities": "Plan",
        }
        added = client.patch(f"/api/v1/projects/{project['id']}", json={
            "expectedVersion": 1, "members": [member], "leadAgentId": lead["id"],
        })
        assert added.status_code == 200, added.text
        cleared = client.patch(f"/api/v1/projects/{project['id']}", json={
            "expectedVersion": 2, "members": [],
        })
        assert cleared.status_code == 200, cleared.text
        assert cleared.json()["project"]["members"] == []
        assert cleared.json()["project"]["leadAgentId"] is None
