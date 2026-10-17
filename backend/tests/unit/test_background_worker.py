from __future__ import annotations

import asyncio
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock

import pytest

from relay.background import (
    BackgroundServices,
    background_mode_from_env,
    create_worker_app,
    interval_cron,
    worker_conninfo,
)


def services():
    return BackgroundServices(
        scheduler=SimpleNamespace(tick=AsyncMock(), interval_seconds=10),
        computer_notifications=SimpleNamespace(tick=Mock(), interval_seconds=15),
        execution_lifecycle=SimpleNamespace(tick=Mock(), interval_seconds=5),
    )


def test_background_mode_defaults_to_embedded(monkeypatch):
    monkeypatch.delenv("RELAY_BACKGROUND_MODE", raising=False)
    assert background_mode_from_env() == "embedded"
    monkeypatch.setenv("RELAY_BACKGROUND_MODE", "external")
    assert background_mode_from_env() == "external"
    monkeypatch.setenv("RELAY_BACKGROUND_MODE", "typo")
    with pytest.raises(ValueError, match="RELAY_BACKGROUND_MODE"):
        background_mode_from_env()


@pytest.mark.parametrize("seconds", [1, 5, 10, 15, 30, 60, 120, 3600])
def test_interval_cron_has_the_requested_cadence(seconds):
    from croniter import croniter
    cron = croniter(interval_cron(seconds), start_time=0)
    assert cron.get_next(float) == seconds
    assert cron.get_next(float) == seconds * 2


@pytest.mark.parametrize("seconds", [0, -1, 1.5, 7, 90, float("inf")])
def test_unsupported_intervals_fail_at_startup(seconds):
    with pytest.raises(ValueError, match="interval"):
        interval_cron(seconds)


def test_worker_conninfo_preserves_credentials_and_connection_options(monkeypatch):
    from psycopg.conninfo import conninfo_to_dict
    monkeypatch.setenv("RELAY_STORAGE", "postgres")
    monkeypatch.setenv("RELAY_DATABASE_URL", "postgresql+psycopg://user:p%40ss@localhost:5439/relay?sslmode=require&options=-csearch_path%3Dtest_jobs")
    assert conninfo_to_dict(worker_conninfo()) == {
        "user": "user", "password": "p@ss", "host": "localhost", "port": "5439",
        "dbname": "relay", "sslmode": "require", "options": "-csearch_path=test_jobs",
    }


def test_worker_requires_postgres_and_shared_storage(monkeypatch):
    with pytest.raises(ValueError, match="RELAY_STORAGE=postgres"):
        worker_conninfo()
    monkeypatch.setenv("RELAY_STORAGE", "postgres")
    with pytest.raises(ValueError, match="PostgreSQL"):
        worker_conninfo()


def test_jobs_invoke_existing_services_through_a_real_procrastinate_worker():
    from procrastinate.testing import InMemoryConnector

    async def run():
        calls = services()
        connector = InMemoryConnector()
        app = create_worker_app(calls, connector=connector)
        async with app.open_async():
            for name in ("relay.scheduler", "relay.computer_notifications", "relay.execution_recovery"):
                await app.tasks[name].defer_async(timestamp=0)
            await app.run_worker_async(wait=False, install_signal_handlers=False, listen_notify=False)
        calls.scheduler.tick.assert_awaited_once()
        calls.computer_notifications.tick.assert_called_once()
        calls.execution_lifecycle.tick.assert_called_once()

    asyncio.run(run())


def test_periodic_registration_coalesces_and_serializes_each_service():
    from procrastinate.testing import InMemoryConnector
    app = create_worker_app(services(), connector=InMemoryConnector())
    for name in ("relay.scheduler", "relay.computer_notifications", "relay.execution_recovery"):
        assert app.tasks[name].lock == name
        assert app.tasks[name].queueing_lock == name
    schedules = app.periodic_registry.periodic_tasks
    assert len(schedules) >= 3


def test_disabled_scheduler_does_not_register_a_dispatch_job():
    from procrastinate.testing import InMemoryConnector
    calls = services()
    calls.scheduler = None
    app = create_worker_app(calls, connector=InMemoryConnector())
    assert "relay.scheduler" not in app.tasks
    assert "relay.computer_notifications" in app.tasks


def test_failed_periodic_work_is_retained_for_inspection():
    from procrastinate.testing import InMemoryConnector

    async def run():
        calls = services()
        calls.scheduler.tick.side_effect = RuntimeError("temporary failure")
        connector = InMemoryConnector()
        app = create_worker_app(calls, connector=connector)
        async with app.open_async():
            job_id = await app.tasks["relay.scheduler"].defer_async(timestamp=0)
            await app.run_worker_async(wait=False, install_signal_handlers=False, listen_notify=False)
        assert connector.jobs[job_id]["status"] == "failed"

    asyncio.run(run())


def test_external_api_keeps_automation_events_without_starting_consumers(monkeypatch, tmp_path):
    from relay.app import create_app
    monkeypatch.setenv("RELAY_BACKGROUND_MODE", "external")
    monkeypatch.setenv("RELAY_TASK_SCHEDULER_ENABLED", "1")
    api = create_app(tmp_path)
    starts = []
    for service in (api.state.task_scheduler, api.state.computer_notifications, api.state.execution_lifecycle):
        monkeypatch.setattr(service, "start", lambda: starts.append(True))
        monkeypatch.setattr(service, "stop", AsyncMock())

    async def run():
        async with api.router.lifespan_context(api):
            assert api.state.task_store.emit_automation_events
            assert api.state.session_store.emit_automation_events

    asyncio.run(run())
    assert starts == []


def test_embedded_api_still_starts_and_stops_services(monkeypatch, tmp_path):
    from relay.app import create_app
    monkeypatch.setenv("RELAY_BACKGROUND_MODE", "embedded")
    monkeypatch.setenv("RELAY_TASK_SCHEDULER_ENABLED", "1")
    api = create_app(tmp_path)
    starts, stops = [], []
    for service in (api.state.task_scheduler, api.state.computer_notifications, api.state.execution_lifecycle):
        start, stop = Mock(), AsyncMock()
        monkeypatch.setattr(service, "start", start)
        monkeypatch.setattr(service, "stop", stop)
        starts.append(start)
        stops.append(stop)

    async def run():
        async with api.router.lifespan_context(api):
            for start in starts:
                start.assert_called_once()

    asyncio.run(run())
    for stop in stops:
        stop.assert_awaited_once()
