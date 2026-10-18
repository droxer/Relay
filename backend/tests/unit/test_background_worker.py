from __future__ import annotations

import asyncio
import threading
from contextlib import asynccontextmanager
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock

import pytest

from relay.background import (
    BackgroundServices,
    background_mode_from_env,
    create_worker_app,
    interval_cron,
    apply_worker_schema,
    run_worker,
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


def test_alembic_does_not_propose_dropping_vendor_queue_tables():
    from relay.persistence import schema
    include = schema.include_alembic_object
    assert not include(None, "procrastinate_jobs", "table", True, None)
    assert include(None, "sessions", "table", True, None)
    assert include(None, "unexpected_table", "table", True, None)
    assert include(None, "procrastinate_jobs", "table", False, object())


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
    monkeypatch.setenv("RELAY_DATABASE_URL", "postgresql+psycopg://user:p%40ss@localhost:5439/relay?sslmode=require&options=-csearch_path%3Dtest_jobs")
    assert conninfo_to_dict(worker_conninfo()) == {
        "user": "user", "password": "p@ss", "host": "localhost", "port": "5439",
        "dbname": "relay", "sslmode": "require", "options": "-csearch_path=test_jobs",
    }


def test_worker_requires_a_postgres_database(monkeypatch):
    # conftest points RELAY_DATABASE_URL at SQLite.
    with pytest.raises(ValueError, match="PostgreSQL"):
        worker_conninfo()
    monkeypatch.delenv("RELAY_DATABASE_URL")
    with pytest.raises(RuntimeError, match="RELAY_DATABASE_URL"):
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


def test_cancelled_job_waits_for_database_work_to_finish():
    from procrastinate.testing import InMemoryConnector

    async def run():
        entered = asyncio.Event()
        release = threading.Event()
        loop = asyncio.get_running_loop()
        calls = services()

        def tick():
            loop.call_soon_threadsafe(entered.set)
            assert release.wait(timeout=5)

        calls.computer_notifications.tick = tick
        app = create_worker_app(calls, connector=InMemoryConnector())
        job = asyncio.create_task(app.tasks["relay.computer_notifications"](timestamp=0))
        try:
            await asyncio.wait_for(entered.wait(), 5)
            job.cancel()
            await asyncio.sleep(0)
            assert not job.done()
        finally:
            release.set()
        with pytest.raises(asyncio.CancelledError):
            await job

    asyncio.run(run())


@pytest.mark.parametrize("installed", [False, True])
def test_schema_install_is_explicit_and_idempotent(monkeypatch, installed):
    from relay import background
    opened = []

    @asynccontextmanager
    async def open_app():
        opened.append(True)
        yield

    app = SimpleNamespace(
        open_async=open_app, check_connection_async=AsyncMock(return_value=installed),
        schema_manager=SimpleNamespace(apply_schema_async=AsyncMock()),
    )
    monkeypatch.setattr(background, "worker_conninfo", lambda: "")
    monkeypatch.setattr(background.procrastinate, "App", lambda **kwargs: app)
    asyncio.run(apply_worker_schema())
    assert opened == [True]
    assert app.schema_manager.apply_schema_async.await_count == int(not installed)


@pytest.mark.parametrize("schema_installed", [False, True])
def test_standalone_worker_uses_external_lifespan_and_requires_schema(monkeypatch, schema_installed):
    from relay import app as app_module, background
    events = []

    @asynccontextmanager
    async def open_app():
        events.append("open")
        try:
            yield
        finally:
            events.append("close")

    @asynccontextmanager
    async def lifespan(api):
        events.append("lifespan")
        yield

    calls = services()
    state = SimpleNamespace(task_scheduler=calls.scheduler, computer_notifications=calls.computer_notifications,
                            execution_lifecycle=calls.execution_lifecycle)
    api = SimpleNamespace(state=state, router=SimpleNamespace(lifespan_context=lifespan))
    worker = SimpleNamespace(open_async=open_app, check_connection_async=AsyncMock(return_value=schema_installed),
                             run_worker_async=AsyncMock())
    factory = Mock(return_value=api)
    monkeypatch.setattr(app_module, "create_app", factory)
    monkeypatch.setattr(background, "worker_conninfo", lambda: "")
    monkeypatch.setattr(background, "create_worker_app", lambda services: worker)
    if schema_installed:
        asyncio.run(run_worker("/test/data"))
        worker.run_worker_async.assert_awaited_once()
        assert events == ["open", "lifespan", "close"]
    else:
        with pytest.raises(RuntimeError, match="worker-schema"):
            asyncio.run(run_worker("/test/data"))
        worker.run_worker_async.assert_not_awaited()
        assert events == ["open", "close"]
    factory.assert_called_once_with("/test/data", background_mode="external")


def test_stalled_recovery_only_changes_control_checks_and_prunes_its_queue():
    from procrastinate.jobs import Status
    from procrastinate.testing import InMemoryConnector

    async def run():
        app = create_worker_app(services(), connector=InMemoryConnector())
        jobs = [SimpleNamespace(id=1, task_name="relay.scheduler"),
                SimpleNamespace(id=2, task_name="external.non_replayable")]
        app.job_manager.get_stalled_jobs = AsyncMock(return_value=jobs)
        app.job_manager.finish_job = AsyncMock()
        app.job_manager.delete_old_jobs = AsyncMock()
        await app.tasks["relay.recover_stalled_jobs"](timestamp=60)
        app.job_manager.finish_job.assert_awaited_once_with(jobs[0], status=Status.FAILED, delete_job=False)
        await app.tasks["relay.prune_jobs"](timestamp=3600)
        app.job_manager.delete_old_jobs.assert_awaited_once_with(
            nb_hours=168, queue="relay_control", include_failed=True, include_cancelled=True, include_aborted=True,
        )

    asyncio.run(run())


@pytest.mark.parametrize("status", ["failed", "doing", "deleted"])
def test_recovery_handles_completed_job_races_but_surfaces_database_errors(status):
    from procrastinate import exceptions
    from procrastinate.jobs import Status
    from procrastinate.testing import InMemoryConnector

    async def run():
        app = create_worker_app(services(), connector=InMemoryConnector())
        app.job_manager.get_stalled_jobs = AsyncMock(return_value=[SimpleNamespace(id=1, task_name="relay.scheduler")])
        app.job_manager.finish_job = AsyncMock(side_effect=exceptions.ConnectorException())
        app.job_manager.get_job_status_async = (
            AsyncMock(side_effect=exceptions.NoResult()) if status == "deleted"
            else AsyncMock(return_value=Status(status))
        )
        if status == "doing":
            with pytest.raises(exceptions.ConnectorException):
                await app.tasks["relay.recover_stalled_jobs"](timestamp=60)
        else:
            await app.tasks["relay.recover_stalled_jobs"](timestamp=60)

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


def test_recovery_can_run_even_if_a_previous_recovery_worker_crashed():
    from procrastinate.testing import InMemoryConnector
    app = create_worker_app(services(), connector=InMemoryConnector())
    assert app.tasks["relay.recover_stalled_jobs"].lock is None
    assert app.tasks["relay.recover_stalled_jobs"].queueing_lock is not None


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
