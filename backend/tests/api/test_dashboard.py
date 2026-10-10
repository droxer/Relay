from __future__ import annotations

from datetime import datetime, timedelta, timezone
from tempfile import TemporaryDirectory
from zoneinfo import ZoneInfo

from fastapi.testclient import TestClient
from relay.app import create_app
from relay.persistence.stores import relay_event


def _bootstrap(client: TestClient) -> None:
    response = client.post("/api/v1/auth/bootstrap", json={
        "token": "admin_token",
        "username": "admin",
        "password": "kestrel-vault-7719",
    })
    assert response.status_code == 200
    response = client.post("/api/v1/auth/login", json={"username": "admin", "password": "kestrel-vault-7719"})
    assert response.status_code == 200


def _create_session(client: TestClient) -> str:
    response = client.post("/api/v1/threads", json={
        "taskGoal": "demo",
        "assignments": [{"agent": "claude"}],
        "workspacePath": "/workspace",
    })
    assert response.status_code == 201
    return response.json()["id"]


def test_dashboard_sessions_returns_shape(monkeypatch) -> None:
    monkeypatch.setenv("RELAY_ADMIN_TOKEN", "admin_token")
    with TemporaryDirectory() as root:
        client = TestClient(create_app(root))
        _bootstrap(client)
        _create_session(client)

        response = client.get("/api/v1/admin/dashboard/sessions")
        assert response.status_code == 200
        body = response.json()
        assert body["total"] >= 1
        assert isinstance(body["dailyCounts"], list)
        assert len(body["dailyCounts"]) == 14
        assert all({"date", "count", "completed", "failed"} <= set(row) for row in body["dailyCounts"])
        assert isinstance(body["topEmployees"], list)
        assert isinstance(body["statusCounts"], dict)


def test_database_dashboard_avoids_full_session_and_token_history_reads(
    monkeypatch,
) -> None:
    monkeypatch.setenv("RELAY_ADMIN_TOKEN", "admin_token")
    with TemporaryDirectory() as root:
        app = create_app(root)
        client = TestClient(app)
        _bootstrap(client)
        _create_session(client)

        def unexpected_full_read():
            raise AssertionError("dashboard must not materialize full history")

        monkeypatch.setattr(app.state.session_store, "list_sessions", unexpected_full_read)
        monkeypatch.setattr(app.state.session_store, "list_token_usage", unexpected_full_read)

        assert client.get("/api/v1/admin/dashboard/sessions").status_code == 200
        assert client.get("/api/v1/admin/dashboard/tokens").status_code == 200


def test_control_plane_metrics_reports_notification_health(monkeypatch) -> None:
    monkeypatch.setenv("RELAY_ADMIN_TOKEN", "admin_token")
    with TemporaryDirectory() as root:
        client = TestClient(create_app(root))
        _bootstrap(client)

        response = client.get("/api/v1/admin/control-plane/metrics")

        assert response.status_code == 200
        assert response.json() == {
            "notifications": {
                "published": 0,
                "waits": 0,
                "woken": 0,
                    "timedOut": 0,
                    "activeWaiters": 0,
                    "activeKeys": 0,
                },
            "notificationBridge": {"enabled": False, "connected": False},
        }


def test_api_responses_expose_server_timing(monkeypatch) -> None:
    monkeypatch.setenv("RELAY_ADMIN_TOKEN", "admin_token")
    with TemporaryDirectory() as root:
        client = TestClient(create_app(root))

        response = client.get("/api")

        assert response.status_code == 200
        metric, value = response.headers["server-timing"].split(";dur=")
        assert metric == "app"
        assert float(value) >= 0


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
    started = relay_event("agent.started", session_id, {"runId": run_id, "agent": agent, "role": "fixer"})
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


def _dashboard_client(monkeypatch, root: str):
    monkeypatch.setenv("RELAY_ADMIN_TOKEN", "admin_token")
    app = create_app(root)
    client = TestClient(app)
    _bootstrap(client)
    return app, client


def test_dashboard_tokens_returns_reported_usage(monkeypatch) -> None:
    with TemporaryDirectory() as root:
        app, client = _dashboard_client(monkeypatch, root)
        session_id = _create_session(client)
        # A record from before the cache split: its combined cache counts as reads.
        _record_run(app, session_id, "run_1", {"input": 10, "output": 5, "cache": 2, "total": 17, "source": "codex"})

        response = client.get("/api/v1/admin/dashboard/tokens")
        assert response.status_code == 200
        body = response.json()
        assert body["available"] is True
        assert body["totalInput"] == 10
        assert body["totalOutput"] == 5
        assert body["totalCacheRead"] == 2
        assert body["totalCacheWrite"] == 0
        assert body["totalCache"] == 2
        assert body["total"] == 17
        assert body["fresh"] == 15
        assert body["unreportedRuns"] == []
        assert len(body["daily"]) == 14
        assert "recentSessions" not in body
        assert "byEmployee" not in body


def test_dashboard_tokens_headline_excludes_cache_reads(monkeypatch) -> None:
    with TemporaryDirectory() as root:
        app, client = _dashboard_client(monkeypatch, root)
        session_id = _create_session(client)
        _record_run(app, session_id, "run_1", {
            "input": 10, "output": 5, "cache": 1020, "cacheRead": 1000, "cacheWrite": 20, "total": 1035,
        }, agent="claude")

        body = client.get("/api/v1/admin/dashboard/tokens").json()

        assert body["totalCacheRead"] == 1000
        assert body["totalCacheWrite"] == 20
        assert body["total"] == 1035
        assert body["fresh"] == 35
        today = body["daily"][-1]
        assert (today["fresh"], today["cacheRead"], today["cacheWrite"]) == (35, 1000, 20)


def test_dashboard_tokens_totals_only_cover_last_seven_days(monkeypatch) -> None:
    with TemporaryDirectory() as root:
        app, client = _dashboard_client(monkeypatch, root)
        session_id = _create_session(client)
        _record_run(app, session_id, "run_current", {"input": 10, "output": 5, "cache": 2, "total": 17})
        old_timestamp = (datetime.now(timezone.utc) - timedelta(days=20)).isoformat()
        _record_run(app, session_id, "run_old", {"input": 100, "output": 50, "cache": 25, "total": 175}, timestamp=old_timestamp)

        body = client.get("/api/v1/admin/dashboard/tokens").json()

        assert body["totalInput"] == 10
        assert body["totalOutput"] == 5
        assert body["totalCache"] == 2
        assert body["total"] == 17
        assert sum(day["total"] for day in body["daily"]) == 17


def test_dashboard_tokens_available_when_usage_is_older_than_the_summary_week(monkeypatch) -> None:
    with TemporaryDirectory() as root:
        app, client = _dashboard_client(monkeypatch, root)
        session_id = _create_session(client)
        ten_days_ago = (datetime.now(timezone.utc) - timedelta(days=10)).isoformat()
        _record_run(app, session_id, "run_1", {"input": 10, "output": 5, "cache": 0, "total": 15}, timestamp=ten_days_ago)

        body = client.get("/api/v1/admin/dashboard/tokens").json()

        assert body["total"] == 0
        assert body["available"] is True
        assert sum(day["total"] for day in body["daily"]) == 15


def test_dashboard_tokens_name_runtimes_that_completed_without_usage(monkeypatch) -> None:
    with TemporaryDirectory() as root:
        app, client = _dashboard_client(monkeypatch, root)
        session_id = _create_session(client)
        _record_run(app, session_id, "run_kimi_1", None, agent="kimi")
        _record_run(app, session_id, "run_kimi_2", None, agent="kimi")
        _record_run(app, session_id, "run_pi", None, agent="pi")
        # A failed run that reported nothing says nothing about the runtime.
        _record_run(app, session_id, "run_failed", None, agent="claude", status="failed")
        _record_run(app, session_id, "run_codex", {"input": 1, "output": 1, "cache": 0, "total": 2})

        body = client.get("/api/v1/admin/dashboard/tokens").json()

        assert body["unreportedRuns"] == [{"agent": "kimi", "runs": 2}, {"agent": "pi", "runs": 1}]
        assert body["total"] == 2


def test_dashboard_tokens_count_usage_of_stopped_runs(monkeypatch) -> None:
    with TemporaryDirectory() as root:
        app, client = _dashboard_client(monkeypatch, root)
        session_id = _create_session(client)
        _record_run(app, session_id, "run_1", {"input": 40, "output": 2, "cache": 0, "total": 42}, status="cancelled")

        body = client.get("/api/v1/admin/dashboard/tokens").json()

        assert body["total"] == 42


def test_dashboard_tokens_bucket_days_in_the_viewer_time_zone(monkeypatch) -> None:
    zone = ZoneInfo("Pacific/Kiritimati")  # UTC+14: its day starts the previous UTC day
    local_today = datetime.now(zone).date()
    start_of_local_day = datetime.combine(local_today, datetime.min.time(), tzinfo=zone) + timedelta(seconds=1)
    with TemporaryDirectory() as root:
        app, client = _dashboard_client(monkeypatch, root)
        session_id = _create_session(client)
        _record_run(app, session_id, "run_1", {"input": 7, "output": 0, "cache": 0, "total": 7},
                    timestamp=start_of_local_day.astimezone(timezone.utc).isoformat())

        local = client.get("/api/v1/admin/dashboard/tokens", params={"tz": "Pacific/Kiritimati"}).json()
        utc = client.get("/api/v1/admin/dashboard/tokens", params={"tz": "Not/AZone"}).json()

        assert local["timeZone"] == "Pacific/Kiritimati"
        assert {day["date"]: day["total"] for day in local["daily"]}[local_today.isoformat()] == 7
        assert utc["timeZone"] == "UTC"
        utc_day = start_of_local_day.astimezone(timezone.utc).date().isoformat()
        assert {day["date"]: day["total"] for day in utc["daily"]}[utc_day] == 7


def test_dashboard_tokens_do_not_redate_old_usage_after_unrelated_session_activity(monkeypatch) -> None:
    with TemporaryDirectory() as root:
        app, client = _dashboard_client(monkeypatch, root)
        session_id = _create_session(client)
        old_timestamp = (datetime.now(timezone.utc) - timedelta(days=20)).isoformat()
        _record_run(app, session_id, "run_old", {"input": 100, "output": 50, "cache": 25, "total": 175}, timestamp=old_timestamp)
        app.state.session_store.append_event(session_id, relay_event("human.decision", session_id, {
            "decision": {"id": "dec_recent", "kind": "approve", "createdAt": datetime.now(timezone.utc).isoformat()},
        }))

        response = client.get("/api/v1/admin/dashboard/tokens")

        assert response.status_code == 200
        body = response.json()
        assert body["available"] is False
        assert body["total"] == 0
        assert all(day["total"] == 0 for day in body["daily"])


def test_dashboard_tokens_aggregate_runs_without_double_counting_sessions(monkeypatch) -> None:
    with TemporaryDirectory() as root:
        app, client = _dashboard_client(monkeypatch, root)
        session_id = _create_session(client)
        _record_run(app, session_id, "run_1", {"input": 10, "output": 5, "cache": 2, "total": 17})
        _record_run(app, session_id, "run_2", {"input": 20, "output": 7, "cache": 3, "total": 30})

        body = client.get("/api/v1/admin/dashboard/tokens").json()

        assert body["total"] == 47
