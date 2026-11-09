"""Disposable loopback PostgreSQL/HTTP probe using the real TypeScript daemon.

Fixtures exist only in this explicitly launched test server, never production.
"""
from __future__ import annotations

import argparse
from contextlib import asynccontextmanager
import json
import os
from pathlib import Path
import platform
import secrets
import socket
import subprocess
import sys
from tempfile import TemporaryDirectory
import time

from alembic import command
from alembic.config import Config
from fastapi import FastAPI, Header, HTTPException
from loguru import logger

from relay.app import create_app
from relay.persistence.engine import after_store_commit
from control_plane import schema, environment

ROOT = Path(__file__).resolve().parents[3]


def serve() -> FastAPI:
    """A test-only fixture API mounted before the real application's catch-all."""
    logger.remove()
    app = create_app(os.environ['RELAY_PROBE_ROOT'])
    ctx = app.state.context
    secret = os.environ['RELAY_PROBE_SECRET']
    commits = {}
    publish = ctx.daemon_store.publish_command

    def observed_publish(command_id, **kwargs):
        result = publish(command_id, **kwargs)
        # Observe the existing commit boundary without widening transactions
        # across registry/reaper calls (which changes production lock order).
        after_store_commit(ctx.daemon_store.engine, lambda: commits.setdefault(command_id, time.time() * 1000))
        return result

    ctx.daemon_store.publish_command = observed_publish

    @asynccontextmanager
    async def lifespan(_app):
        async with app.router.lifespan_context(app):
            yield

    probe = FastAPI(lifespan=lifespan)

    @probe.post('/_probe/next')
    def next_run(body: dict, x_relay_probe: str = Header(default='')):
        if not secrets.compare_digest(x_relay_probe, secret):
            raise HTTPException(401)
        node_id = body.get('nodeId', '')
        if not isinstance(node_id, str) or len(node_id) > 100:
            raise HTTPException(400)
        token = secrets.token_hex(32) if body.get('register') else None
        if token:
            owner = ctx.auth_store.ensure_user('transport-benchmark')['id']
            ctx.registry.register({'sandboxId': node_id, 'userId': owner, 'token': token,
                'protocolVersion': 2, 'supportedAgents': ['codex'], 'maxConcurrentRuns': 3,
                'capabilities': ['thread-workspaces', 'durable-reports'],
                'executorCapabilities': [{'executorKind': 'codex', 'status': 'ready', 'adapter': 'cli', 'maxConcurrentRuns': 3}]})
            return {'token': token}
        session = ctx.backend._run_sync(node_id, {'taskGoal': 'synthetic transport load',
            'assignments': [{'agent': 'codex', 'mode': 'action'}], 'workspaceLayout': 'thread'})
        request = ctx.daemon_store.active_run_request_for_session(node_id, session['id'])
        if not request or not request.get('currentCommandId'):
            raise HTTPException(500, 'Synthetic run was not queued.')
        return {'commandId': request['currentCommandId'], 'committedAt': commits.pop(request['currentCommandId'])}


    probe.mount('/', app)
    return probe


def free_port() -> int:
    with socket.socket() as listener:
        listener.bind(('127.0.0.1', 0))
        return listener.getsockname()[1]


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--database-url', required=True, help='Explicit disposable loopback PostgreSQL base URL')
    parser.add_argument('--replicas', type=int, choices=[1, 2], default=1)
    parser.add_argument('--daemons', type=int, default=100)
    parser.add_argument('--warmup', type=float, default=120)
    parser.add_argument('--duration', type=float, default=600)
    parser.add_argument('--rtt-ms', type=float, default=100)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--fault', choices=['none', 'blackhole', 'ack-loss', 'duplicates', 'server-error'], default='none')
    parser.add_argument('--fault-seconds', type=float, default=30)
    args = parser.parse_args()
    if not 1 <= args.daemons <= 100 or min(args.duration, args.warmup, args.rtt_ms, args.fault_seconds) < 0 or args.duration == 0:
        parser.error('Use 1–100 daemons, positive duration, and nonnegative timing values.')
    args.output = args.output.resolve()
    with schema(args.database_url) as database, TemporaryDirectory(prefix='relay-transport-probe-') as directory:
        secret = secrets.token_hex(32)
        settings = {'RELAY_DATABASE_URL': database, 'RELAY_TASK_SCHEDULER_ENABLED': '0',
                    'RELAY_STARTUP_REPAIRS': '0', 'RELAY_PROBE_ROOT': directory, 'RELAY_PROBE_SECRET': secret}
        servers = []
        try:
            with environment(settings):
                config = Config(str(ROOT / 'backend/alembic.ini'))
                config.set_main_option('script_location', str(ROOT / 'backend/migrations'))
                command.upgrade(config, 'head')
            ports = [free_port() for _ in range(args.replicas)]
            process_env = {**os.environ, **settings, 'PYTHONPATH': os.pathsep.join([str(ROOT / 'backend'), str(Path(__file__).parent)])}
            for port in ports:
                log = open(Path(directory) / f'backend-{port}.log', 'w')
                process = subprocess.Popen([sys.executable, '-m', 'uvicorn', 'daemon_transport:serve', '--factory',
                    '--host', '127.0.0.1', '--port', str(port), '--log-level', 'error'], env=process_env, stdout=log, stderr=log)
                servers.append((process, log))
            for port in ports:
                deadline = time.monotonic() + 60
                while True:
                    try:
                        with socket.create_connection(('127.0.0.1', port), timeout=0.2):
                            break
                    except OSError:
                        if time.monotonic() > deadline:
                            raise RuntimeError('Disposable backend did not start; inspect probe logs.') from None
                        time.sleep(0.1)
            profile = {'urls': [f'http://127.0.0.1:{port}' for port in ports], 'secret': secret,
                'daemons': args.daemons, 'warmup': args.warmup, 'duration': args.duration, 'rttMs': args.rtt_ms,
                'root': directory, 'output': str(args.output), 'fault': args.fault, 'faultSeconds': args.fault_seconds,
                'environment': {'platform': platform.platform(), 'cpuCount': os.cpu_count(), 'replicas': args.replicas,
                                'database': 'disposable PostgreSQL', 'clock': 'same-host wall clock; acknowledgement latencies are conservative upper bounds'}}
            profile_path = Path(directory) / 'profile.json'
            profile_path.write_text(json.dumps(profile))
            profile_path.chmod(0o600)
            result = subprocess.run(['node', str(ROOT / 'tools/benchmark-daemon-transport.mjs'), str(profile_path)],
                                    cwd=ROOT, timeout=args.warmup + args.duration + args.fault_seconds + 240, check=False)
            if result.returncode:
                raise SystemExit(result.returncode)
        finally:
            for process, log in servers:
                process.terminate()
                try:
                    process.wait(timeout=15)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait()
                log.close()
            diagnostic_logs = args.output.with_suffix(".backend.log")
            diagnostic_logs.write_text("\n".join(path.read_text() for path in Path(directory).glob("backend-*.log")))


if __name__ == '__main__':
    main()
