"""Disposable PostgreSQL registry heartbeat probe (no HTTP or agent execution).

Measures SQL amplification, not fleet capacity. Use daemon_transport.py for
end-to-end transport latency and fault acceptance.
"""
from __future__ import annotations

import argparse
from collections import Counter
import json
import math
from pathlib import Path
import secrets
import time

from loguru import logger
from sqlalchemy import event, func, select

from control_plane import distribution, schema
from relay.core.ids import new_database_id
from relay.daemon_registry.registry import DaemonNodeRegistry
from relay.persistence.daemon.store import DatabaseDaemonStore
from relay.persistence.session.store import DatabaseSessionStore


def measure(database, computers, replicas, rounds, interval, active):
    store = DatabaseDaemonStore(database, create_schema=True)
    sessions = DatabaseSessionStore(database, create_schema=True)
    registries = [DaemonNodeRegistry(sessions, store) for _ in range(replicas)]
    nodes = [(new_database_id(), secrets.token_hex(24)) for _ in range(computers)]
    leases = {}
    for node, token in nodes:
        registries[0].register({'sandboxId': node, 'token': token, 'protocolVersion': 1,
                                'supportedAgents': ['codex'], 'capabilities': ['workspace-scope']})
        for _ in range(active):
            store.enqueue_command(node, {'id': new_database_id(), 'type': 'runtime.refresh'})
        leases[node] = [(row['id'], row['leaseId']) for row in store.take_queued_commands(node)]
    # Every replica has a warm configuration view before measurement.
    for registry in registries:
        for node, _token in nodes:
            registry._hydrate_node(node)
    counts = Counter()
    latencies = []

    def statement(_conn, _cursor, sql, *_args):
        lowered = sql.lower()
        counts[lowered.split()[0]] += 1
        if 'daemon_node_agents' in lowered:
            counts['inventory'] += 1

    def begin(_conn):
        counts['transactions'] += 1

    event.listen(store.engine, 'before_cursor_execute', statement)
    event.listen(store.engine, 'begin', begin)
    cpu = time.process_time()
    started = time.monotonic()
    try:
        for tick in range(rounds):
            if tick:
                time.sleep(max(0, started + tick * interval - time.monotonic()))
            for node, token in nodes:
                for registry in registries:
                    before = time.perf_counter()
                    registry.heartbeat(node, token, leases[node])
                    latencies.append((time.perf_counter() - before) * 1000)
    finally:
        event.remove(store.engine, 'before_cursor_execute', statement)
        event.remove(store.engine, 'begin', begin)
    elapsed = time.monotonic() - started
    cpu_seconds = time.process_time() - cpu
    with store.engine.connect() as conn:
        version = conn.scalar(select(func.version()))
    latency = distribution(latencies)
    latency['p99'] = round(sorted(latencies)[math.ceil(len(latencies) * 0.99) - 1], 3)
    return {'computers': computers, 'replicas': replicas, 'rounds': rounds,
            'intervalSeconds': interval, 'activeCommandsPerComputer': active,
            'requests': len(latencies), 'sql': dict(counts), 'elapsedSeconds': elapsed,
            'pythonCpuSeconds': cpu_seconds, 'heartbeatMs': latency,
            'databaseVersion': version,
            'limits': 'Sequential in-process registries; no HTTP, poll, faults, WAL, HOT or server CPU measurement.'}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--database-url', required=True)
    parser.add_argument('--computers', type=int, nargs='+', default=[1, 10, 100])
    parser.add_argument('--replicas', type=int, nargs='+', default=[1, 2])
    parser.add_argument('--rounds', type=int, default=3)
    parser.add_argument('--interval', type=float, default=6)
    parser.add_argument('--active', type=int, default=0)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    if (not all(1 <= n <= 100 for n in args.computers)
            or not all(n in (1, 2) for n in args.replicas)
            or args.rounds < 1 or not math.isfinite(args.interval) or args.interval < 0
            or not 0 <= args.active <= 50):
        parser.error('Use 1–100 Computers, 1–2 replicas, positive rounds, nonnegative interval, 0–50 commands.')
    logger.remove()
    results = []
    for computers in args.computers:
        for replicas in args.replicas:
            with schema(args.database_url) as database:
                results.append(measure(database, computers, replicas, args.rounds, args.interval, args.active))
    args.output.write_text(json.dumps(results, indent=2) + '\n')


if __name__ == '__main__':
    main()
