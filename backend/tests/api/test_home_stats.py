from __future__ import annotations

from datetime import UTC, date, datetime, timedelta
from tempfile import TemporaryDirectory

from fastapi.testclient import TestClient

from relay.app import create_app
from relay.persistence.events import relay_event, relay_task_event


def _bootstrap_admin(client: TestClient) -> str:
    response = client.post("/api/v1/auth/bootstrap", json={
        "token": "admin_token",
        "username": "admin",
        "email": "admin@example.com",
        "password": "kestrel-vault-7719",
    })
    assert response.status_code == 200
    login = client.post("/api/v1/auth/login", json={
        "username": "admin",
        "password": "kestrel-vault-7719",
    })
    assert login.status_code == 200
    return login.json()["user"]["userId"]


def _create_member(admin_client: TestClient, app, username: str) -> tuple[TestClient, str]:
    created = admin_client.post("/api/v1/admin/users", json={
        "userId": username,
        "username": username,
        "email": f"{username}@example.com",
        "password": "kestrel-vault-8821",
        "displayName": username.title(),
    })
    assert created.status_code == 201, created.text
    member_client = TestClient(app)
    login = member_client.post("/api/v1/auth/login", json={
        "username": username,
        "password": "kestrel-vault-8821",
    })
    assert login.status_code == 200
    return member_client, login.json()["user"]["userId"]


def _record_run(
    app,
    session_id: str,
    run_id: str,
    usage: dict | None,
    *,
    agent: str = "codex",
    status: str = "completed",
    timestamp: str | None = None,
) -> None:
    started = relay_event("agent.started", session_id, {"runId": run_id, "agent": agent, "role": "implementer"})
    completed = relay_event("agent.completed", session_id, {
        "runId": run_id,
        "agent": agent,
        "status": status,
        "exitCode": 0 if status == "completed" else 1,
        **({"tokenUsage": usage} if usage else {}),
    })
    if timestamp:
        started["timestamp"] = timestamp
        completed["timestamp"] = timestamp
    app.state.session_store.append_event(session_id, started)
    app.state.session_store.append_event(session_id, completed)


def _mark_task_done(app, task_id: str, timestamp: str) -> None:
    event = relay_task_event("task.status", task_id, {"status": "done"})
    event["timestamp"] = timestamp
    app.state.task_store.append_event(task_id, event)


def test_home_stats_requires_auth_and_validates_period(monkeypatch) -> None:
    monkeypatch.setenv("RELAY_ADMIN_TOKEN", "admin_token")
    with TemporaryDirectory() as root:
        app = create_app(root)
        anon = TestClient(app)
        assert anon.get("/api/v1/home/stats").status_code == 401

        client = TestClient(app)
        _bootstrap_admin(client)
        assert client.get("/api/v1/home/stats", params={"period": "quarter"}).status_code == 422


def test_home_stats_scopes_tasks_conversations_runs_and_tokens_per_user(monkeypatch) -> None:
    monkeypatch.setenv("RELAY_ADMIN_TOKEN", "admin_token")
    with TemporaryDirectory() as root:
        app = create_app(root)
        admin_client = TestClient(app)
        admin_id = _bootstrap_admin(admin_client)
        alice_client, alice_id = _create_member(admin_client, app, "alice")

        now = datetime.now(UTC)
        today = now.date()
        monday = today - timedelta(days=today.weekday())
        this_week_ts = datetime.combine(monday, datetime.min.time(), tzinfo=UTC).isoformat().replace("+00:00", "Z")
        last_month_ts = (datetime.combine(monday, datetime.min.time(), tzinfo=UTC) - timedelta(days=12)).isoformat().replace("+00:00", "Z")
        very_old_ts = (datetime.combine(monday, datetime.min.time(), tzinfo=UTC) - timedelta(days=50)).isoformat().replace("+00:00", "Z")

        # Alice's tasks:
        # 1. Completed this week
        t_week = app.state.task_store.create_task({
            "title": "Done this week", "description": "", "priority": "normal", "ownerUserId": alice_id,
        })
        _mark_task_done(app, t_week["id"], this_week_ts)

        # 2. Completed 12 days before Monday (outside "week", inside "30d"), then edited today:
        #    must NOT count as completed this week even though updated_at is today!
        t_prior_month = app.state.task_store.create_task({
            "title": "Done earlier", "description": "", "priority": "normal", "ownerUserId": alice_id,
        })
        _mark_task_done(app, t_prior_month["id"], last_month_ts)
        app.state.task_store.append_event(
            t_prior_month["id"],
            relay_task_event("task.updated", t_prior_month["id"], {"title": "Done earlier (edited)"}),
        )

        # 3. Completed 50 days before Monday (only in "all")
        t_old = app.state.task_store.create_task({
            "title": "Done long ago", "description": "", "priority": "normal", "ownerUserId": alice_id,
        })
        _mark_task_done(app, t_old["id"], very_old_ts)

        # 4. Open in-progress task
        t_open = app.state.task_store.create_task({
            "title": "In flight", "description": "", "priority": "normal", "ownerUserId": alice_id,
        })
        app.state.task_store.append_event(
            t_open["id"], relay_task_event("task.status", t_open["id"], {"status": "running"}),
        )

        # 5. Routine (must be excluded from issue task stats)
        app.state.task_store.create_task({
            "title": "Weekly check", "description": "", "priority": "normal",
            "ownerUserId": alice_id, "isRoutine": True,
        })

        # Admin's task completed this week (must never leak into Alice's stats)
        t_admin = app.state.task_store.create_task({
            "title": "Admin work", "description": "", "priority": "normal", "ownerUserId": admin_id,
        })
        _mark_task_done(app, t_admin["id"], this_week_ts)

        # Alice's standalone chat + runs
        alice_chat = alice_client.post("/api/v1/threads", json={
            "taskGoal": "Alice chat",
            "assignments": [{"agent": "claude"}],
            "workspacePath": "/workspace",
        })
        assert alice_chat.status_code == 201
        alice_session_id = alice_chat.json()["id"]
        _record_run(
            app, alice_session_id, "run_alice_1",
            {"input": 100, "output": 50, "cache": 520, "cacheRead": 500, "cacheWrite": 20, "total": 670},
            agent="claude", timestamp=this_week_ts,
        )
        _record_run(
            app, alice_session_id, "run_alice_unreported", None,
            agent="pi", timestamp=this_week_ts,
        )
        _record_run(
            app, alice_session_id, "run_alice_old",
            {"input": 1000, "output": 500, "cache": 0, "total": 1500},
            agent="codex", timestamp=very_old_ts,
        )

        # Admin's chat + run (must never leak into Alice's stats)
        admin_chat = admin_client.post("/api/v1/threads", json={
            "taskGoal": "Admin chat",
            "assignments": [{"agent": "codex"}],
            "workspacePath": "/workspace",
        })
        assert admin_chat.status_code == 201
        _record_run(
            app, admin_chat.json()["id"], "run_admin_1",
            {"input": 9999, "output": 9999, "cache": 0, "total": 19998},
            agent="codex", timestamp=this_week_ts,
        )

        # Check Alice's "week" stats
        week_resp = alice_client.get("/api/v1/home/stats", params={"period": "week", "tz": "UTC"})
        assert week_resp.status_code == 200
        week = week_resp.json()
        assert week["period"] == "week"
        assert week["startDate"] == monday.isoformat()
        assert week["endDate"] == today.isoformat()
        assert week["timeZone"] == "UTC"
        assert week["tasks"] == {"completed": 1, "created": 4, "open": 1, "inProgress": 1}
        assert week["conversations"]["chats"] == 1
        assert week["conversations"]["standaloneChats"] == 1
        assert week["conversations"]["projectChats"] == 0
        assert week["runs"]["total"] == 2
        assert week["runs"]["reported"] == 1
        assert week["runs"]["unreported"] == 1
        assert week["tokens"]["fresh"] == 170  # 100 + 50 + 20 (cacheRead excluded)
        assert week["tokens"]["input"] == 100
        assert week["tokens"]["output"] == 50
        assert week["tokens"]["cacheWrite"] == 20
        assert week["tokens"]["cacheRead"] == 500
        assert week["tokens"]["total"] == 670

        # Check Alice's "30d" stats (includes t_prior_month, excludes t_old)
        thirty_resp = alice_client.get("/api/v1/home/stats", params={"period": "30d", "tz": "UTC"})
        assert thirty_resp.status_code == 200
        thirty = thirty_resp.json()
        assert thirty["tasks"]["completed"] == 2
        assert thirty["runs"]["total"] == 2
        assert thirty["tokens"]["fresh"] == 170

        # Check Alice's "all" stats (includes t_old and run_alice_old, still excludes admin)
        all_resp = alice_client.get("/api/v1/home/stats", params={"period": "all", "tz": "Not/AZone"})
        assert all_resp.status_code == 200
        all_stats = all_resp.json()
        assert all_stats["startDate"] is None
        assert all_stats["endDate"] is None
        assert all_stats["timeZone"] == "UTC"
        assert all_stats["tasks"]["completed"] == 3
        assert all_stats["runs"]["total"] == 3
        assert all_stats["tokens"]["fresh"] == 1670

        # Check Admin only sees Admin's own stats
        admin_week = admin_client.get("/api/v1/home/stats", params={"period": "week", "tz": "UTC"}).json()
        assert admin_week["tasks"]["completed"] == 1
        assert admin_week["conversations"]["chats"] == 1
        assert admin_week["runs"]["total"] == 1
        assert admin_week["tokens"]["fresh"] == 19998


def test_home_stats_week_starts_on_monday_in_viewer_zone(monkeypatch) -> None:
    monkeypatch.setenv("RELAY_ADMIN_TOKEN", "admin_token")
    with TemporaryDirectory() as root:
        app = create_app(root)
        client = TestClient(app)
        _bootstrap_admin(client)
        body = client.get("/api/v1/home/stats", params={"period": "week", "tz": "Asia/Shanghai"}).json()
        assert body["timeZone"] == "Asia/Shanghai"
        start = date.fromisoformat(body["startDate"])
        end = date.fromisoformat(body["endDate"])
        assert start.weekday() == 0
        assert 0 <= (end - start).days <= 6
