"""Manual local PostgreSQL workload probe; no timing thresholds or agent execution.

Run with RELAY_BENCHMARK_DATABASE_URL pointing explicitly at a loopback test
PostgreSQL. Each dataset gets a freshly migrated, owned scratch schema, removed
in finally. ASGI requests exercise real authentication/routes/store queries;
network/proxy overhead and autonomous background loops are outside this probe.
"""

from __future__ import annotations

import argparse
import asyncio
from collections import Counter, defaultdict
from contextlib import ExitStack, contextmanager
from contextvars import ContextVar
from datetime import UTC, datetime
import json
import math
import os
from pathlib import Path
import platform
import secrets
import sys
from tempfile import TemporaryDirectory
from threading import Lock
import time
from uuid import uuid4

from alembic import command
from alembic.config import Config
import httpx
from loguru import logger
from sqlalchemy import create_engine, event, func, select, text
from sqlalchemy.engine import make_url

from relay.api.admin.dashboard import DASHBOARD_CACHE
from relay.app import create_app
from relay.automations.service import AutomationService
from relay.persistence.automation.store import insert_outbox_rows
from relay.persistence.engine import store_transaction
from relay.persistence.events import relay_event
from relay.persistence.tables.automations import automation_outbox
from relay.persistence.tables.tasks import tasks as task_rows


try:
    import resource
except ImportError:
    resource = None

SCOPE: ContextVar[str] = ContextVar("probe_scope", default="setup")
PATHS = {
    "threads": "/api/v1/threads?view=summary&limit=100",
    "tasks": "/api/v1/tasks?view=summary&limit=100",
    "artifacts": "/api/v1/artifacts?limit=50",
    "sessionMetrics": "/api/v1/admin/dashboard/sessions",
    "tokenMetrics": "/api/v1/admin/dashboard/tokens?tz=America/New_York",
}


def distribution(values: list[float]) -> dict[str, float | int]:
    if not values:
        return {"samples": 0}
    ordered = sorted(values)
    return {
        "samples": len(values),
        "p50": round(ordered[math.ceil(len(values) * 0.5) - 1], 3),
        "p95": round(ordered[math.ceil(len(values) * 0.95) - 1], 3),
        "max": round(ordered[-1], 3),
    }


@contextmanager
def environment(values: dict[str, str]):
    previous = {key: os.environ.get(key) for key in values}
    os.environ.update(values)
    try:
        yield
    finally:
        for key, value in previous.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value


@contextmanager
def schema(base: str):
    parsed = make_url(base)
    if (
        parsed.get_backend_name() != "postgresql"
        or parsed.host not in {"localhost", "127.0.0.1", "::1"}
        or parsed.query
    ):
        raise ValueError("Probe requires an explicit loopback PostgreSQL URL without query parameters.")
    name = f"relay_bench_{uuid4().hex}"
    admin = create_engine(base)
    with admin.begin() as conn:
        conn.execute(text(f'CREATE SCHEMA "{name}"'))
    scoped = parsed.update_query_dict({"options": f"-csearch_path={name}"}).render_as_string(hide_password=False)
    try:
        yield scoped
    finally:
        with admin.begin() as conn:
            conn.execute(text(f'DROP SCHEMA IF EXISTS "{name}" CASCADE'))
        admin.dispose()


class Traffic:
    """Observe checkout duration, query count and checked-out connection peak."""

    def __init__(self, engine):
        self.engine = engine
        self.lock = Lock()
        self.original = engine.pool.connect
        self.clear()

        def acquire():
            start = time.perf_counter()
            try:
                return self.original()
            finally:
                with self.lock:
                    self.pool_ms[SCOPE.get()].append((time.perf_counter() - start) * 1000)

        self.acquire = acquire

    def clear(self):
        self.pool_ms: dict[str, list[float]] = defaultdict(list)
        self.queries: Counter[str] = Counter()
        self.active = self.peak = 0

    def query(self, *args):
        with self.lock:
            self.queries[SCOPE.get()] += 1

    def checkout(self, *args):
        with self.lock:
            self.active += 1
            self.peak = max(self.peak, self.active)

    def checkin(self, *args):
        with self.lock:
            self.active -= 1

    def __enter__(self):
        self.engine.pool.connect = self.acquire
        for kind, callback in (
            ("before_cursor_execute", self.query),
            ("checkout", self.checkout),
            ("checkin", self.checkin),
        ):
            event.listen(self.engine, kind, callback)
        return self

    def __exit__(self, *args):
        self.engine.pool.connect = self.original
        for kind, callback in (
            ("before_cursor_execute", self.query),
            ("checkout", self.checkout),
            ("checkin", self.checkin),
        ):
            event.remove(self.engine, kind, callback)


def seed(app, owner: str, *, threads: int, tasks: int, history: int, routines: int):
    ctx = app.state.context
    ctx.task_store.emit_automation_events = ctx.session_store.emit_automation_events = False
    engine = ctx.session_store.engine
    for index in range(tasks):
        ctx.task_store.create_task({"title": f"Probe task {index}", "ownerUserId": owner})
    for index in range(threads):
        with store_transaction(engine):
            session = ctx.session_store.create_session(
                {"taskGoal": f"Probe thread {index}", "workspacePath": "/probe", "ownerUserId": owner}
            )
            sid = session["id"]
            ctx.session_store.append_event(sid, relay_event("agent.started", sid, {"runId": "probe", "agent": "codex"}))
            for sequence in range(history):
                ctx.session_store.append_event(
                    sid,
                    relay_event(
                        "agent.output",
                        sid,
                        {
                            "runId": "probe",
                            "agent": "codex",
                            "stream": "stdout",
                            "text": "x" * 4096,
                            "sequence": sequence,
                        },
                    ),
                    hydrate_events=False,
                )
            ctx.session_store.append_event(
                sid,
                relay_event(
                    "agent.completed",
                    sid,
                    {
                        "runId": "probe",
                        "agent": "codex",
                        "status": "completed",
                        "exitCode": 0,
                        "agentLog": "completed",
                        "tokenUsage": {"input": 10, "output": 5, "cache": 2, "total": 17},
                    },
                ),
                hydrate_events=False,
            )
            ctx.session_store.create_artifact(
                sid,
                {
                    "kind": "workspace_file",
                    "title": "Probe artifact",
                    "path": f"result-{index}.txt",
                    "body": "probe",
                },
            )
    target = str(uuid4())
    for index in range(routines):
        ctx.task_store.create_task(
            {
                "title": f"Probe automation {index}",
                "ownerUserId": owner,
                "isRoutine": True,
                "routineState": "active",
                "assignedAgent": "codex",
                "assignedAgentId": target,
                "routineTriggers": [{"kind": "task_event", "on": "status_changed", "filters": {"toStatus": "blocked"}}],
            }
        )
    with engine.begin() as conn:
        for table in (
            "tasks",
            "sessions",
            "session_events",
            "session_run_token_usage",
            "session_workspace_files",
            "automation_state",
        ):
            conn.execute(text(f"ANALYZE {table}"))


async def phase(client, app, traffic, *, owner: str, concurrency: int, requests: int, automated: bool):
    traffic.clear()
    DASHBOARD_CACHE.clear()
    latencies: dict[str, list[float]] = defaultdict(list)
    sizes: dict[str, list[int]] = defaultdict(list)
    statuses: Counter[int] = Counter()
    gate = asyncio.Semaphore(concurrency)
    stop = asyncio.Event()
    lag: list[float] = []
    tick_ms: list[float] = []
    fired = []

    async def monitor():
        while not stop.is_set():
            due = time.perf_counter() + 0.005
            await asyncio.sleep(0.005)
            lag.append(max(0, time.perf_counter() - due) * 1000)

    async def request(index):
        name = list(PATHS)[index % len(PATHS)]
        async with gate:
            token = SCOPE.set(name)
            start = time.perf_counter()
            try:
                response = await client.get(PATHS[name])
                latencies[name].append((time.perf_counter() - start) * 1000)
                sizes[name].append(len(response.content))
                statuses[response.status_code] += 1
                if response.status_code != 200:
                    raise RuntimeError(f"Probe request {name} returned {response.status_code}")
            finally:
                SCOPE.reset(token)

    async def automation():
        token = SCOPE.set("automation")
        try:
            ctx = app.state.context

            def enqueue():
                with ctx.session_store.engine.begin() as conn:
                    insert_outbox_rows(
                        conn,
                        [
                            {
                                "kind": "task_event",
                                "event_type": "task.status_changed",
                                "depth": 0,
                                "payload": {"subject": {"ownerUserId": owner}, "to": "blocked"},
                            }
                        ],
                    )

            await asyncio.to_thread(enqueue)
            service = AutomationService(
                task_store=ctx.task_store,
                session_store=ctx.session_store,
                automation_store=ctx.automation_store,
                project_store=ctx.project_store,
                connections=ctx.connections,
                batch=25,
            )
            for _ in range(10000):
                start = time.perf_counter()
                fired.append(await asyncio.to_thread(service.tick, datetime.now(UTC)))
                tick_ms.append((time.perf_counter() - start) * 1000)
                pending = await asyncio.to_thread(outbox_pending, ctx.session_store.engine)
                if not pending:
                    return
                await asyncio.sleep(0)
            raise RuntimeError("Probe broadcast did not finish")
        finally:
            SCOPE.reset(token)

    ticker = asyncio.create_task(monitor())
    background = asyncio.create_task(automation()) if automated else None
    start = time.perf_counter()
    try:
        outcomes = await asyncio.gather(*(request(index) for index in range(requests)), return_exceptions=True)
        http_seconds = time.perf_counter() - start
        if background:
            await background
        errors = [result for result in outcomes if isinstance(result, BaseException)]
        if errors:
            raise RuntimeError(f"{len(errors)} probe requests failed") from errors[0]
    finally:
        stop.set()
        await ticker
        if background and not background.done():
            await asyncio.gather(asyncio.shield(background), return_exceptions=True)
    if traffic.active:
        raise RuntimeError("A measured operation left a checked-out connection")
    return {
        "concurrency": concurrency,
        "requests": requests,
        "httpSeconds": round(http_seconds, 3),
        "httpRequestsPerSecond": round(requests / http_seconds, 2),
        "statusCounts": dict(statuses),
        "eventLoopDelayMs": distribution(lag),
        "peakCheckedOut": traffic.peak,
        "operations": {
            name: {
                "latencyMs": distribution(values),
                "decodedResponseBytes": distribution(sizes[name]),
                "queries": traffic.queries[name],
                "poolAcquisitionMs": distribution(traffic.pool_ms[name]),
            }
            for name, values in latencies.items()
        },
        "automation": {
            "ticks": len(tick_ms),
            "tickLatencyMs": distribution(tick_ms),
            "fired": sum(fired),
            "maxFiredPerTick": max(fired, default=0),
            "queries": traffic.queries["automation"],
            "poolAcquisitionMs": distribution(traffic.pool_ms["automation"]),
        },
    }


def outbox_pending(engine):
    with engine.connect() as conn:
        return conn.scalar(select(automation_outbox.c.id).limit(1)) is not None


async def dataset(url, *, scale: int, requests: int, pool_size: int, overflow: int):
    overrides = {
        "RELAY_DATABASE_URL": url,
        "RELAY_DB_POOL_SIZE": str(pool_size),
        "RELAY_DB_MAX_OVERFLOW": str(overflow),
        "RELAY_DB_POOL_TIMEOUT_SECONDS": "5",
        "RELAY_TASK_SCHEDULER_ENABLED": "0",
        "RELAY_STARTUP_REPAIRS": "0",
        "RELAY_BLOB_STORE": "database",
        "RELAY_WAITLIST_ENABLED": "0",
        "RELAY_CHANNELS_ENABLED": "0",
        "RELAY_ADMIN_TOKEN": secrets.token_urlsafe(32),
        "RELAY_MAIL_CLOUDFLARE_ACCOUNT_ID": "",
        "RELAY_MAIL_CLOUDFLARE_API_TOKEN": "",
        "RELAY_MAIL_FROM": "",
    }
    with environment(overrides), TemporaryDirectory(prefix="relay-probe-") as root:
        backend = Path(__file__).resolve().parents[2]
        config = Config(str(backend / "alembic.ini"))
        config.set_main_option("script_location", str(backend / "migrations"))
        command.upgrade(config, "head")
        app = create_app(root, background_mode="external")
        engine = app.state.context.session_store.engine
        try:
            with engine.connect() as conn:
                server_version = conn.scalar(text("SHOW server_version"))
            async with httpx.AsyncClient(transport=httpx.ASGITransport(app), base_url="http://probe.local") as client:
                password = secrets.token_urlsafe(24)
                response = await client.post(
                    "/api/v1/auth/bootstrap",
                    json={"token": overrides["RELAY_ADMIN_TOKEN"], "username": "probe", "password": password},
                )
                response.raise_for_status()
                response = await client.post("/api/v1/auth/login", json={"username": "probe", "password": password})
                response.raise_for_status()
                owner = response.json()["user"]["userId"]
                counts = {"threads": 25 * scale, "tasks": 100 * scale, "history": 20, "routines": 100 * scale}
                print(f"Seeding scale {scale}: {counts}", file=sys.stderr, flush=True)
                await asyncio.to_thread(seed, app, owner, **counts)
                with ExitStack() as stack:
                    for _ in range(pool_size):
                        stack.enter_context(engine.connect())
                for path in PATHS.values():
                    (await client.get(path)).raise_for_status()
                with Traffic(engine) as traffic:
                    results = []
                    for concurrency in (1, 8, 16):
                        print(f"Measuring scale {scale}, concurrency {concurrency}", file=sys.stderr, flush=True)
                        results.append(
                            await phase(
                                client,
                                app,
                                traffic,
                                owner=owner,
                                concurrency=concurrency,
                                requests=requests,
                                automated=concurrency == 16,
                            )
                        )
                with engine.connect() as conn:
                    single_occurrence = conn.scalar(
                        select(func.count())
                        .select_from(task_rows)
                        .where(
                            task_rows.c.is_routine.is_(True),
                            func.jsonb_array_length(task_rows.c.snapshot["occurrenceIds"]) == 1,
                        )
                    )
                if results[-1]["automation"]["fired"] != counts["routines"] or single_occurrence != counts["routines"]:
                    raise RuntimeError("Probe broadcast did not create exactly one occurrence per routine")
                return {
                    "scale": scale,
                    "fixture": counts,
                    "applicationPoolCapacity": pool_size + overflow,
                    "poolSize": pool_size,
                    "maxOverflow": overflow,
                    "postgresVersion": server_version,
                    "verifiedSingleOccurrenceRoutines": single_occurrence,
                    "phases": results,
                }
        finally:
            engine.dispose()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--requests", type=int, default=150)
    parser.add_argument("--pool-size", type=int, default=2)
    parser.add_argument("--overflow", type=int, default=1)
    parser.add_argument("--scales", type=int, nargs="+", default=[1, 5])
    args = parser.parse_args()
    if args.requests < 5 or min(args.pool_size, args.overflow) < 1 or any(scale < 1 for scale in args.scales):
        parser.error("requests must be >= 5; scales and pool settings must be positive")
    base = os.environ.get("RELAY_BENCHMARK_DATABASE_URL")
    if not base:
        parser.error("set RELAY_BENCHMARK_DATABASE_URL explicitly to a local test PostgreSQL")
    logger.disable("relay")
    results = []
    for scale in args.scales:
        with schema(base) as url:
            results.append(
                asyncio.run(
                    dataset(url, scale=scale, requests=args.requests, pool_size=args.pool_size, overflow=args.overflow)
                )
            )
    args.output.write_text(
        json.dumps(
            {
                "runAt": datetime.now(UTC).isoformat(),
                "python": platform.python_version(),
                "system": platform.system(),
                "processPeakRss": {
                    "value": resource.getrusage(resource.RUSAGE_SELF).ru_maxrss,
                    "unit": "bytes" if sys.platform == "darwin" else "KiB",
                }
                if resource
                else None,
                "machine": platform.machine(),
                "transport": "in-process ASGI",
                "tickIntervalMs": 5,
                "datasets": results,
            },
            indent=2,
        )
        + "\n"
    )
    print(f"Wrote {args.output}")


if __name__ == "__main__":
    main()
