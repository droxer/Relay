"""Queue guarantees against a real, disposable PostgreSQL schema."""
from __future__ import annotations

import asyncio
import os
import uuid
from pathlib import Path

import psycopg
import pytest
from psycopg.conninfo import conninfo_to_dict, make_conninfo
from procrastinate.jobs import Status
from sqlalchemy import create_engine, text

from relay.background import BackgroundServices, apply_worker_schema, create_worker_app, worker_conninfo
from test_background_worker import services

pytestmark = pytest.mark.postgres


@pytest.fixture
def postgres_queue(monkeypatch):
    url = os.environ.get("RELAY_TEST_DATABASE_URL")
    if not url:
        pytest.skip("set RELAY_TEST_DATABASE_URL for the PostgreSQL worker tests")
    engine = create_engine(url)
    schema = "worker_test_" + uuid.uuid4().hex
    with engine.begin() as conn:
        conn.execute(text(f'CREATE SCHEMA "{schema}"'))
    monkeypatch.setenv("RELAY_DATABASE_URL", url)
    options = conninfo_to_dict(worker_conninfo())
    options["options"] = f"-csearch_path={schema}"
    dsn = make_conninfo(**options)
    try:
        yield dsn
    finally:
        with engine.begin() as conn:
            conn.execute(text(f'DROP SCHEMA "{schema}" CASCADE'))
        engine.dispose()


def app_for(dsn, calls=None):
    from procrastinate import PsycopgConnector
    return create_worker_app(calls or services(), connector=PsycopgConnector(conninfo=dsn))


def test_jobs_survive_a_producer_restart_and_are_processed_once(postgres_queue):
    async def run():
        producer = app_for(postgres_queue)
        async with producer.open_async():
            await producer.schema_manager.apply_schema_async()
            await producer.tasks["relay.scheduler"].defer_async(timestamp=0)
        calls = services()
        consumer = app_for(postgres_queue, calls)
        # Disable automatic schedules to isolate the persisted job.
        consumer.periodic_registry.periodic_tasks.clear()
        async with consumer.open_async():
            await consumer.run_worker_async(wait=False, install_signal_handlers=False)
            await consumer.run_worker_async(wait=False, install_signal_handlers=False)
        calls.scheduler.tick.assert_awaited_once()
    asyncio.run(run())


def test_alembic_autogeneration_preserves_vendor_schema(postgres_queue, monkeypatch):
    from alembic import command
    from alembic.config import Config
    from sqlalchemy.engine import URL

    params = conninfo_to_dict(postgres_queue)
    url = URL.create("postgresql+psycopg", username=params["user"], host=params["host"],
                     port=int(params["port"]), database=params["dbname"], query={"options": params["options"]})
    monkeypatch.setenv("RELAY_DATABASE_URL", url.render_as_string(hide_password=False))
    backend_root = Path(__file__).resolve().parents[2]
    config = Config(str(backend_root / "alembic.ini"))
    config.set_main_option("script_location", str(backend_root / "migrations"))
    command.upgrade(config, "head")

    async def install():
        app = app_for(postgres_queue)
        async with app.open_async():
            await app.schema_manager.apply_schema_async()
    asyncio.run(install())
    # Uses the actual env.py autogeneration configuration, not just the filter.
    command.check(config)


def test_schema_installer_is_idempotent_on_postgres(postgres_queue, monkeypatch):
    from relay import background
    monkeypatch.setattr(background, "worker_conninfo", lambda: postgres_queue)

    async def run():
        await apply_worker_schema()
        await apply_worker_schema()
        app = app_for(postgres_queue)
        async with app.open_async():
            assert await app.check_connection_async()
    asyncio.run(run())


def test_worker_processes_real_relay_services(postgres_queue, monkeypatch, tmp_path):
    from alembic import command
    from alembic.config import Config
    from relay.app import create_app
    from sqlalchemy.engine import URL

    params = conninfo_to_dict(postgres_queue)
    url = URL.create("postgresql+psycopg", username=params["user"], host=params["host"],
                     port=int(params["port"]), database=params["dbname"], query={"options": params["options"]})
    monkeypatch.setenv("RELAY_DATABASE_URL", url.render_as_string(hide_password=False))
    backend_root = Path(__file__).resolve().parents[2]
    config = Config(str(backend_root / "alembic.ini"))
    config.set_main_option("script_location", str(backend_root / "migrations"))
    command.upgrade(config, "head")

    async def run():
        api = create_app(tmp_path, background_mode="external")
        worker = create_worker_app(BackgroundServices.from_state(api.state))
        worker.periodic_registry.periodic_tasks.clear()
        async with worker.open_async():
            await worker.schema_manager.apply_schema_async()
            async with api.router.lifespan_context(api):
                for name in ("relay.scheduler", "relay.computer_notifications", "relay.execution_recovery"):
                    await worker.tasks[name].defer_async(timestamp=0)
                await worker.run_worker_async(wait=False, install_signal_handlers=False)
                # Success deletes all three checks; a failed check remains.
                assert list(await worker.job_manager.list_jobs_async(queue="relay_control")) == []
    asyncio.run(run())


def test_periodic_schedules_deduplicate_across_worker_instances(postgres_queue):
    from procrastinate.periodic import PeriodicDeferrer

    async def run():
        first, second = app_for(postgres_queue), app_for(postgres_queue)
        async with first.open_async(), second.open_async():
            await first.schema_manager.apply_schema_async()
            for app in (first, second):
                deferrer = PeriodicDeferrer(app.periodic_registry)
                await deferrer.defer_jobs(deferrer.get_previous_tasks(at=120))
            jobs = list(await first.job_manager.list_jobs_async(queue="relay_control"))
            assert len(jobs) == len(first.periodic_registry.periodic_tasks)
    asyncio.run(run())


def test_stalled_tick_with_a_pending_tick_cannot_block_recovery(postgres_queue):
    async def run():
        app = app_for(postgres_queue)
        async with app.open_async():
            await app.schema_manager.apply_schema_async()
            stale_id = await app.tasks["relay.scheduler"].defer_async(timestamp=0)
            worker_id = await app.job_manager.register_worker()
            stale = await app.job_manager.fetch_job(queues=["relay_control"], worker_id=worker_id)
            assert stale.id == stale_id
            pending_id = await app.tasks["relay.scheduler"].defer_async(timestamp=10)
            with psycopg.connect(postgres_queue) as conn:
                conn.execute("UPDATE procrastinate_workers SET last_heartbeat = now() - interval '2 minutes'")
            await app.tasks["relay.recover_stalled_jobs"](timestamp=60)
            assert await app.job_manager.get_job_status_async(stale_id) == Status.FAILED
            pending = await app.job_manager.fetch_job(queues=["relay_control"], worker_id=worker_id)
            assert pending.id == pending_id
    asyncio.run(run())


def test_execution_lock_serializes_jobs_across_workers(postgres_queue):
    async def run():
        entered = asyncio.Event()
        release = asyncio.Event()
        active, peak, count = 0, 0, 0

        async def tick():
            nonlocal active, peak, count
            active += 1
            peak = max(peak, active)
            count += 1
            entered.set()
            await release.wait()
            active -= 1

        first_calls, second_calls = services(), services()
        first_calls.scheduler.tick = tick
        second_calls.scheduler.tick = tick
        first, second = app_for(postgres_queue, first_calls), app_for(postgres_queue, second_calls)
        first.periodic_registry.periodic_tasks.clear()
        second.periodic_registry.periodic_tasks.clear()
        async with first.open_async(), second.open_async():
            await first.schema_manager.apply_schema_async()
            await first.tasks["relay.scheduler"].defer_async(timestamp=0)
            work = asyncio.create_task(first.run_worker_async(wait=False, install_signal_handlers=False))
            try:
                await asyncio.wait_for(entered.wait(), 5)
                await second.tasks["relay.scheduler"].defer_async(timestamp=10)
                await second.run_worker_async(wait=False, install_signal_handlers=False)
                assert count == 1
            finally:
                release.set()
                await work
            await second.run_worker_async(wait=False, install_signal_handlers=False)
            assert count == 2
            assert peak == 1
    asyncio.run(run())
