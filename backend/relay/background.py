"""Procrastinate adapters for Relay's existing control-plane services.

The queue owns delivery and worker coordination. Task admission, automation
occurrences, execution evidence, and notifications remain owned by their domain
services. No agent process is executed here.
"""

from __future__ import annotations

import asyncio
import math
import os
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any, cast

import procrastinate
from procrastinate.app import WorkerOptions
from loguru import logger
from procrastinate.jobs import Status
from psycopg.conninfo import make_conninfo
from sqlalchemy.engine import make_url

from . import app as app_module
from .core.storage_config import database_url_from_env, use_postgres_storage

CONTROL_QUEUE = "relay_control"
CONTROL_TASKS = frozenset({
    "relay.scheduler", "relay.computer_notifications", "relay.execution_recovery",
    "relay.recover_stalled_jobs", "relay.prune_jobs",
})


def background_mode_from_env() -> str:
    mode = os.environ.get("RELAY_BACKGROUND_MODE", "embedded").strip().lower()
    if mode not in ("embedded", "external"):
        raise ValueError("RELAY_BACKGROUND_MODE must be embedded or external.")
    return mode


def worker_conninfo() -> str:
    """Translate SQLAlchemy's URL without losing escaped secrets or options."""
    if not use_postgres_storage():
        raise ValueError("The background worker requires RELAY_STORAGE=postgres.")
    url = make_url(database_url_from_env(setting="relay worker"))
    if url.get_backend_name() != "postgresql":
        raise ValueError("The background worker requires a PostgreSQL database.")
    options = url.translate_connect_args(username="user", database="dbname")
    options.update(url.query)
    return make_conninfo(**options)


def interval_cron(seconds: float) -> str:
    """Croniter's optional sixth field is seconds, after day-of-week.

    Control-plane intervals must divide a minute, hour, or day so cron has a
    uniform cadence. Embedded mode continues to support arbitrary intervals.
    """
    if math.isfinite(seconds) and seconds > 0 and seconds == int(seconds):
        interval = int(seconds)
        if interval < 60 and 60 % interval == 0:
            return f"* * * * * */{interval}"
        if interval < 3600 and interval % 60 == 0 and 3600 % interval == 0:
            return f"*/{interval // 60} * * * * 0"
        if interval <= 86400 and interval % 3600 == 0 and 86400 % interval == 0:
            return f"0 */{interval // 3600} * * * 0"
    raise ValueError(
        "Worker interval must be a positive whole number of seconds dividing "
        "a minute, hour, or day (for example 5, 10, 15, 60, 120, or 3600)."
    )


@dataclass
class BackgroundServices:
    scheduler: Any
    computer_notifications: Any
    execution_lifecycle: Any

    @classmethod
    def from_state(cls, state: Any) -> BackgroundServices:
        return cls(state.task_scheduler, state.computer_notifications, state.execution_lifecycle)


async def _finish_thread(callback: Callable[[], Any]) -> None:
    # Cancelling to_thread does not stop its thread. Hold the job's execution
    # lock until its store writes finish, including during worker shutdown.
    work = asyncio.create_task(asyncio.to_thread(callback))
    try:
        await asyncio.shield(work)
    except asyncio.CancelledError:
        await work
        raise


def create_worker_app(
    services: BackgroundServices,
    *,
    connector: Any | None = None,
) -> procrastinate.App:
    app = procrastinate.App(
        connector=connector if connector is not None else procrastinate.PsycopgConnector(conninfo=worker_conninfo()),
        # procrastinate reads a None graceful timeout as "wait indefinitely",
        # though its WorkerOptions type declares a float.
        worker_defaults=cast(WorkerOptions, {
            "queues": [CONTROL_QUEUE],
            "concurrency": 3,
            # Wait for store work to finish on graceful termination.
            "shutdown_graceful_timeout": None,
            # Retain failures; successful high-frequency checks need no history.
            "delete_jobs": "successful",
        }),
    )

    def periodic(name: str, seconds: float):
        def register(callback):
            task = app.task(
                name=name, queue=CONTROL_QUEUE, lock=name, queueing_lock=name,
                # The next scheduled tick rechecks durable domain state. A
                # failed tick must not introduce agent-dispatch retries.
                retry=False,
            )(callback)
            return app.periodic(cron=interval_cron(seconds))(task)
        return register

    if services.scheduler is not None:
        @periodic("relay.scheduler", services.scheduler.interval_seconds)
        async def scheduler(timestamp: int) -> None:
            await services.scheduler.tick()

    @periodic("relay.computer_notifications", services.computer_notifications.interval_seconds)
    async def computer_notifications(timestamp: int) -> None:
        await _finish_thread(services.computer_notifications.tick)

    @periodic("relay.execution_recovery", services.execution_lifecycle.interval_seconds)
    async def execution_recovery(timestamp: int) -> None:
        await _finish_thread(services.execution_lifecycle.tick)

    @app.periodic(cron="* * * * *")
    @app.task(name="relay.recover_stalled_jobs", queue=CONTROL_QUEUE, queueing_lock="relay.recover_stalled_jobs")
    async def recover_stalled_jobs(timestamp: int) -> None:
        # No execution lock on maintenance: an abandoned maintenance job must
        # not prevent the next one from recovering it. Queueing still coalesces.
        # Only our checks are restart-safe; leave unrelated jobs untouched.
        stalled = await app.job_manager.get_stalled_jobs(queue=CONTROL_QUEUE)
        for job in stalled:
            if job.task_name in CONTROL_TASKS:
                try:
                    # Requeueing would conflict with a fresh pending tick's
                    # queueing lock. Retain the failed check and let the next
                    # tick scan durable domain state. This is not agent exit.
                    await app.job_manager.finish_job(job, status=Status.FAILED, delete_job=False)
                    logger.warning("Recovered abandoned background check", job_id=job.id, task=job.task_name)
                except procrastinate.exceptions.ConnectorException:
                    # Another maintainer or the original worker may have
                    # finished it since the scan. Surface actual DB failures.
                    if job.id is None:  # a job read back from the queue always has one
                        raise
                    try:
                        status = await app.job_manager.get_job_status_async(job.id)
                    except procrastinate.exceptions.NoResult:
                        continue  # Successful checks are deleted on completion.
                    if status in (Status.DOING, Status.TODO):
                        raise

    @periodic("relay.prune_jobs", 3600)
    async def prune_jobs(timestamp: int) -> None:
        await app.job_manager.delete_old_jobs(
            nb_hours=168, queue=CONTROL_QUEUE,
            include_failed=True, include_cancelled=True, include_aborted=True,
        )

    return app


async def run_worker(root_dir: str | None = None) -> None:
    # Validate shared storage before construction can touch private file stores.
    worker_conninfo()
    create_app = app_module.create_app
    api = create_app(root_dir, background_mode="external") if root_dir else create_app(background_mode="external")
    worker = create_worker_app(BackgroundServices.from_state(api.state))
    async with worker.open_async():
        if not await worker.check_connection_async():
            raise RuntimeError("Procrastinate schema is missing; run relay worker-schema first.")
        # Keep PostgreSQL notification bridging alive, but start no local
        # scheduling loops. This process binds no HTTP socket.
        async with api.router.lifespan_context(api):
            await worker.run_worker_async()


async def apply_worker_schema() -> None:
    """Explicit, idempotent initial schema install, separate from API startup.

    Procrastinate owns its tables/functions; Relay's Alembic metadata does not.
    Package upgrades need Procrastinate's supplied SQL migrations.
    """
    app = procrastinate.App(connector=procrastinate.PsycopgConnector(conninfo=worker_conninfo()))
    async with app.open_async():
        if not await app.check_connection_async():
            await app.schema_manager.apply_schema_async()
