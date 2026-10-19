from __future__ import annotations

from tempfile import TemporaryDirectory

from fastapi.testclient import TestClient
from relay.api.threads.projections import session_awaits_human
from relay.persistence.session.workspace_artifacts import (
    is_workspace_artifact,
    workspace_artifacts,
)
from relay.app import create_app
from relay.persistence.engine import store_transaction
from sqlalchemy import update


def _admin_id(app) -> str:
    # The bootstrapped admin's User row has a random id, not one derived
    # from its handle.
    return app.state.auth_store.resolve_user_id("admin")


def test_is_workspace_artifact_only_allows_generated_files() -> None:
    assert is_workspace_artifact({"kind": "workspace_file"}) is True
    assert is_workspace_artifact({"kind": "plan"}) is False
    assert is_workspace_artifact({"kind": "review"}) is False
    assert is_workspace_artifact({"kind": "command_log"}) is False


def test_workspace_artifacts_filters_to_generated_files() -> None:
    session = {
        "artifacts": [
            {"id": "plan", "kind": "plan"},
            {"id": "log", "kind": "command_log"},
            {"id": "diff", "kind": "diff"},
            {"id": "deck", "kind": "workspace_file"},
        ],
    }
    filtered = workspace_artifacts(session)
    assert [artifact["id"] for artifact in filtered] == ["deck"]


def test_session_assignment_and_handoff_have_no_execution_mode(monkeypatch) -> None:
    monkeypatch.setenv("RELAY_ADMIN_TOKEN", "admin_token")
    with TemporaryDirectory() as root:
        app = create_app(root)
        client = TestClient(app)
        response = client.post("/api/v1/auth/bootstrap", json={
            "token": "admin_token",
            "username": "admin",
            "password": "kestrel-vault-7719",
        })
        assert response.status_code == 200

        created = client.post("/api/v1/threads", json={
            "taskGoal": "Explain the task",
            "assignments": [{"agent": "codex"}],
        })
        assert created.status_code == 201
        session_id = created.json()["id"]

        [plan] = [artifact for artifact in created.json()["artifacts"] if artifact["title"] == "Assignment plan"]
        assert '"mode"' not in app.state.session_store.read_artifact(
            session_id, plan["id"]
        )

        handed = client.post(f"/api/v1/threads/{session_id}/handoffs", json={
            "targetAgent": "claude",
            "note": "Answer without editing files.",
        })
        assert handed.status_code == 200
        assert handed.json()["decisions"][-1]["kind"] == "handoff"
        assert handed.json()["decisions"][-1]["targetAgent"] == "claude"

        [latest_plan] = [
            artifact
            for artifact in handed.json()["artifacts"]
            if artifact["title"] == "Assignment plan"
        ][-1:]
        assert '"mode"' not in app.state.session_store.read_artifact(
            session_id, latest_plan["id"]
        )


def test_session_creation_persists_the_selected_computer(monkeypatch) -> None:
    monkeypatch.setenv("RELAY_ADMIN_TOKEN", "admin_token")
    with TemporaryDirectory() as root:
        app = create_app(root)
        client = TestClient(app)
        response = client.post(
            "/api/v1/auth/bootstrap",
            json={
                "token": "admin_token",
                "username": "admin",
                "password": "kestrel-vault-7719",
            },
        )
        assert response.status_code == 200
        app.state.registry.register(
            {
                "sandboxId": "node_a",
                "userId": _admin_id(app),
                "token": "node_token",
                "workspacePath": "/workspace/admin",
                "protocolVersion": 1,
                "supportedAgents": ["codex"],
                "status": "ready",
            }
        )

        created = client.post(
            "/api/v1/threads",
            json={"taskGoal": "Start here", "daemonNodeId": "node_a"},
        )

        assert created.status_code == 201, created.text
        assert created.json()["daemonNodeId"] == "node_a"


def test_session_creation_on_an_user_device_computer_persists_a_device_identity(
    monkeypatch,
) -> None:
    """Important 3 回归：user-device 节点（无 managedNodeId，只有
    userId + workspaceId）创建出的 thread，snapshot 必须带 device:
    身份 —— 懒回填对这类节点永远拿不到 managedNodeId 历史，只能靠创建路径
    自己写对。"""
    monkeypatch.setenv("RELAY_ADMIN_TOKEN", "admin_token")
    with TemporaryDirectory() as root:
        app = create_app(root)
        client = TestClient(app)
        response = client.post(
            "/api/v1/auth/bootstrap",
            json={
                "token": "admin_token",
                "username": "admin",
                "password": "kestrel-vault-7719",
            },
        )
        assert response.status_code == 200
        app.state.registry.register(
            {
                "sandboxId": "node_device_a",
                "userId": _admin_id(app),
                "workspaceId": "machine-abc123",
                "token": "node_token",
                "workspacePath": "/workspace/admin",
                "protocolVersion": 1,
                "supportedAgents": ["codex"],
                "status": "ready",
            }
        )

        created = client.post(
            "/api/v1/threads",
            json={"taskGoal": "Start here", "daemonNodeId": "node_device_a"},
        )

        assert created.status_code == 201, created.text
        body = created.json()
        assert body["daemonNodeId"] == "node_device_a"
        assert body.get("managedNodeId") is None
        assert body["computerId"] == f"device:{_admin_id(app)}:machine-abc123"


def test_session_read_backfills_managed_affinity_from_deleted_runtime_history(
    monkeypatch,
) -> None:
    monkeypatch.setenv("RELAY_ADMIN_TOKEN", "admin_token")
    with TemporaryDirectory() as root:
        app = create_app(root)
        client = TestClient(app)
        response = client.post(
            "/api/v1/auth/bootstrap",
            json={
                "token": "admin_token",
                "username": "admin",
                "password": "kestrel-vault-7719",
            },
        )
        assert response.status_code == 200
        app.state.registry.daemon_store.register_node(
            {
                "id": "runtime_old",
                "userId": "admin",
                "managedNodeId": "computer_admin",
                "workspacePath": "/workspace/admin",
                "sandboxMode": "boxlite",
                "nodeLocation": "managed",
                "status": "ready",
                "agents": {"codex": "ready"},
                "createdAt": "2026-06-13T00:00:00.000Z",
                "updatedAt": "2026-06-13T00:00:00.000Z",
            }
        )
        app.state.registry.daemon_store.delete_node("runtime_old")
        session = app.state.session_store.create_session(
            {
                "workspacePath": "/workspace/admin",
                "daemonNodeId": "runtime_old",
                "ownerUserId": "admin",
                "taskGoal": "continue after replacement",
                "participants": ["human", "codex"],
            }
        )

        fetched = client.get(f"/api/v1/threads/{session['id']}")

        assert fetched.status_code == 200, fetched.text
        assert fetched.json()["managedNodeId"] == "computer_admin"
        assert fetched.json()["computerId"] == "managed:computer_admin"
        persisted = app.state.session_store.get_session(session["id"])
        assert persisted.get("managedNodeId") is None
        assert persisted.get("computerId") is None
        assert all(
            event["type"] != "session.runtime_affinity"
            for event in persisted["events"]
        )


def test_thread_read_does_not_500_when_registration_history_disagrees_with_the_sessions_own_managed_node(
    monkeypatch,
) -> None:
    """只读推导必须优先用 session 自己记录的 managedNodeId，而不是
    daemon 注册历史；GET 返回派生身份，但不写事件或 snapshot。"""
    monkeypatch.setenv("RELAY_ADMIN_TOKEN", "admin_token")
    with TemporaryDirectory() as root:
        app = create_app(root)
        client = TestClient(app)
        response = client.post(
            "/api/v1/auth/bootstrap",
            json={
                "token": "admin_token",
                "username": "admin",
                "password": "kestrel-vault-7719",
            },
        )
        assert response.status_code == 200

        # 注册历史把 runtime_1 关联到 computer_B.
        app.state.registry.daemon_store.register_node(
            {
                "id": "runtime_1",
                "userId": "admin",
                "managedNodeId": "computer_B",
                "workspacePath": "/workspace/admin",
                "sandboxMode": "boxlite",
                "nodeLocation": "managed",
                "status": "ready",
                "agents": {"codex": "ready"},
                "createdAt": "2026-06-13T00:00:00.000Z",
                "updatedAt": "2026-06-13T00:00:00.000Z",
            }
        )

        # 存量 session：自己记的是 computer_A（与注册历史不一致）。创建时
        # 走正常路径（无 managedNodeId、无 computerId，daemonNodeId 已知），
        # 然后直接改写 snapshot 列注入 managedNodeId —— 模拟本次修复上线前
        # 就已经存在、只带 managedNodeId、没有 computerId 的老快照（那些行
        # 是旧代码写的，不可能再通过现在的 create_session/append_event 产
        # 生，因为两者现在都会顺带派生出 computerId）。
        store = app.state.session_store
        session = store.create_session(
            {
                "workspacePath": "/workspace/admin",
                "daemonNodeId": "runtime_1",
                "ownerUserId": "admin",
                "taskGoal": "continue after replacement",
                "participants": ["human", "codex"],
            }
        )
        session_id = session["id"]
        legacy_snapshot = {**session, "managedNodeId": "computer_A"}
        legacy_snapshot.pop("events", None)
        with store_transaction(store.engine) as conn:
            conn.execute(
                update(store.sessions)
                .where(store.sessions.c.id == session_id)
                .values(snapshot=legacy_snapshot)
            )

        precondition = store.get_session(session_id)
        assert precondition.get("computerId") is None
        assert precondition["managedNodeId"] == "computer_A"

        fetched = client.get(f"/api/v1/threads/{session_id}")

        assert fetched.status_code == 200, fetched.text
        body = fetched.json()
        assert body["computerId"] == "managed:computer_A"
        assert body["managedNodeId"] == "computer_A"
        persisted = app.state.session_store.get_session(session_id)
        assert persisted.get("computerId") is None
        assert all(
            event["type"] != "session.runtime_affinity"
            for event in persisted["events"]
        )


def test_a_round_that_stopped_to_ask_awaits_its_human() -> None:
    assert session_awaits_human({"status": "waiting_for_human"}) is True
    assert session_awaits_human({"status": "completed", "workOutcome": "blocked"}) is True
    # A failed session also reads blocked; it is settled, not waiting.
    assert session_awaits_human({"status": "failed", "workOutcome": "blocked"}) is False
    assert session_awaits_human({"status": "completed", "workOutcome": "accepted"}) is False


def test_a_thread_awaits_its_human_by_the_task_waiting_in_it() -> None:
    waiting_task = {
        "id": "task_1", "status": "waiting_for_human", "waitingSessionId": "ses_1",
    }
    scoped = {
        "id": "ses_1", "status": "completed", "workOutcome": "blocked",
        "activeRoundId": "r1",
        "collaborationRounds": [{"roundId": "r1", "workScope": {"kind": "task", "taskId": "task_1"}}],
    }
    # A status question since then does not orphan the wait the task names.
    after_status = {**scoped, "workOutcome": "unverified"}
    assert session_awaits_human(after_status, [waiting_task]) is True
    # The task answered elsewhere or finished: the blocked outcome is history.
    assert session_awaits_human(scoped, [{**waiting_task, "waitingSessionId": "ses_2"}]) is False
    assert session_awaits_human(scoped, [{"id": "task_1", "status": "done"}]) is False
    # A task the caller does not hold proves nothing.
    assert session_awaits_human(scoped, []) is True
