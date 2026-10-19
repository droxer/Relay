from __future__ import annotations

import asyncio

from relay.realtime.event_notifier import KeyedEventNotifier


def test_keyed_event_notifier_wakes_only_matching_waiters() -> None:
    async def scenario() -> None:
        notifier = KeyedEventNotifier()

        async def observed_wait(key: str, wait_seconds: float) -> bool:
            with notifier.observe(key) as version:
                return await notifier.wait(key, version, timeout=wait_seconds)

        session_waiter = asyncio.create_task(observed_wait("session:one", 0.2))
        other_waiter = asyncio.create_task(observed_wait("session:two", 0.02))
        await asyncio.sleep(0)

        notifier.publish("session:one")

        assert await session_waiter is True
        assert await other_waiter is False
        assert notifier.stats() == {
            "published": 1,
            "waits": 2,
            "woken": 1,
            "timedOut": 1,
            "activeWaiters": 0,
            "activeKeys": 0,
        }

    asyncio.run(scenario())


def test_keyed_event_notifier_closes_waiters_without_leaking() -> None:
    async def scenario() -> None:
        notifier = KeyedEventNotifier()

        async def observed_wait() -> bool:
            with notifier.observe("node:one") as version:
                return await notifier.wait("node:one", version, timeout=10)

        waiter = asyncio.create_task(observed_wait())
        await asyncio.sleep(0)

        notifier.close()

        assert await waiter is False
        assert notifier.waiter_count == 0
        assert notifier.stats()["activeKeys"] == 0

    asyncio.run(scenario())


def test_keyed_event_notifier_handles_fanout_without_cross_key_wakeups() -> None:
    async def scenario() -> None:
        notifier = KeyedEventNotifier()

        async def observed_wait(key: str) -> bool:
            with notifier.observe(key) as version:
                return await notifier.wait(key, version, timeout=1)

        waiters = [
            asyncio.create_task(observed_wait(f"session:{index % 16}"))
            for index in range(256)
        ]
        await asyncio.sleep(0)

        for index in range(16):
            notifier.publish(f"session:{index}")

        assert all(await asyncio.gather(*waiters))
        assert notifier.stats()["woken"] == 256
        assert notifier.waiter_count == 0
        assert notifier.stats()["activeKeys"] == 0

    asyncio.run(scenario())


def test_keyed_event_notifier_reclaims_high_cardinality_keys() -> None:
    async def scenario() -> None:
        notifier = KeyedEventNotifier()
        for index in range(2_000):
            key = f"workspace:command-{index}"
            with notifier.observe(key) as version:
                notifier.publish(key)
                assert await notifier.wait(key, version, timeout=0.1)

        for index in range(2_000, 4_000):
            notifier.publish(f"workspace:command-{index}")

        assert notifier.stats()["activeKeys"] == 0
        assert notifier.waiter_count == 0

    asyncio.run(scenario())
