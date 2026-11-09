"""Command queue recovery must balance idle reads with lease/liveness safety."""
from __future__ import annotations

import asyncio
from contextlib import contextmanager
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from starlette.datastructures import QueryParams

from relay.api.computers import daemon_wire
from relay.realtime.event_notifier import PostgresNotificationBridge, KeyedEventNotifier


@pytest.mark.parametrize(
    ("bridge_states", "lease", "liveness", "expected"),
    [([True], 60, 30_000, [.5] * 24),
     ([True, False], 60, 30_000, [.5] * 24),
     ([False], 60, 30_000, [.5] * 24),
     (None, 60, 30_000, [.5] * 24),
     ([True], 3, 30_000, [.5] * 24),
     ([True], 1, 30_000, [1 / 3] * 36),
     ([True], 60, 5_000, [.5] * 24)],
)
def test_command_recovery_interval(monkeypatch, bridge_states, lease, liveness, expected):
    clock = [0.0]
    waits = []
    reads = []
    renewals = []

    @contextmanager
    def observe(_key):
        yield 0

    async def wait(_key, _version, *, timeout):
        waits.append(timeout)
        clock[0] += timeout

    monkeypatch.setattr(daemon_wire, "time", SimpleNamespace(monotonic=lambda: clock[0]))
    ctx = SimpleNamespace(
        notification_bridge=None if bridge_states is None else SimpleNamespace(
            stats=lambda: {"connected": bridge_states[min(len(waits), len(bridge_states) - 1)]}),
        control_plane_notifier=SimpleNamespace(observe=observe, wait=wait),
        registry=SimpleNamespace(
            liveness_timeout_ms=liveness,
            renew_active_command_leases=lambda *args, **kwargs: renewals.append(args),
            take_commands=lambda *args, **kwargs: reads.append(args) or [],
            command_lease_observations=lambda *args: {},
            heartbeat_settings=lambda: {},
        ),
    )
    request = SimpleNamespace(
        query_params=QueryParams({"waitSeconds": "12", "leaseSeconds": str(lease)}),
        headers={"authorization": "Bearer token"},
        is_disconnected=AsyncMock(return_value=False),
    )
    result = asyncio.run(daemon_wire.daemon_commands("node", request, ctx))
    assert result["commands"] == []
    assert waits == pytest.approx(expected)
    assert len(reads) == len(expected) + 1
    assert len(renewals) == len(reads)


def test_bridge_connected_means_listen_ready_and_resets_on_stop(monkeypatch):
    async def scenario():
        listening = asyncio.Event()
        release = asyncio.Event()

        class Connection:
            async def __aenter__(self):
                return self

            async def __aexit__(self, *_args):
                pass

            async def execute(self, _query):
                listening.set()
                await release.wait()

            async def notifies(self, **_kwargs):
                await asyncio.Future()
                yield  # pragma: no cover

        monkeypatch.setattr(
            "relay.realtime.event_notifier.psycopg.AsyncConnection.connect",
            AsyncMock(return_value=Connection()),
        )
        bridge = PostgresNotificationBridge("postgresql://localhost/relay", KeyedEventNotifier())
        bridge.start()
        try:
            await listening.wait()
            assert bridge.stats()["connected"] is False
            release.set()
            await asyncio.sleep(0)
            assert bridge.stats()["connected"] is True
        finally:
            await bridge.stop()
        assert bridge.stats()["connected"] is False

    asyncio.run(scenario())


def test_command_notification_wakes_before_slow_recovery_tick():
    notifier = KeyedEventNotifier()
    reads = []
    command = {"id": "refresh", "type": "runtime.refresh"}

    def take_commands(*_args, **_kwargs):
        reads.append(True)
        if len(reads) == 1:
            notifier.publish("node:node")
            return []
        return [command]

    ctx = SimpleNamespace(
        notification_bridge=SimpleNamespace(stats=lambda: {"connected": True}),
        control_plane_notifier=notifier,
        registry=SimpleNamespace(
            liveness_timeout_ms=30_000,
            renew_active_command_leases=lambda *args, **kwargs: None,
            take_commands=take_commands,
            command_lease_observations=lambda *args: {},
            heartbeat_settings=lambda: {},
        ),
    )
    request = SimpleNamespace(
        query_params=QueryParams({"waitSeconds": "12"}),
        headers={"authorization": "Bearer token"},
        is_disconnected=AsyncMock(return_value=False),
    )
    result = asyncio.run(daemon_wire.daemon_commands("node", request, ctx))
    assert result["commands"] == [command]
    assert len(reads) == 2
    assert notifier.stats()["woken"] == 1
    assert notifier.stats()["timedOut"] == 0
