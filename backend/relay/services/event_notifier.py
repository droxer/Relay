"""Low-latency keyed wakeups with an optional PostgreSQL replica bridge."""

from __future__ import annotations

import asyncio
from collections import defaultdict
from collections.abc import Iterator
from contextlib import contextmanager
from threading import Lock
from typing import Any

import psycopg
from loguru import logger
from psycopg import sql
from sqlalchemy.engine import make_url

CONTROL_PLANE_NOTIFICATION_CHANNEL = "relay_control_plane"


def session_event_key(session_id: str) -> str:
    return f"session:{session_id}"


def daemon_command_key(node_id: str) -> str:
    return f"node:{node_id}"


def workspace_response_key(command_id: str) -> str:
    return f"workspace:{command_id}"


class KeyedEventNotifier:
    """Wake async waiters for one domain key without cross-key contention.

    ``publish`` is thread-safe so synchronous stores may call it after a commit
    even when those stores are later moved to a worker thread.
    """

    def __init__(self) -> None:
        self._lock = Lock()
        self._versions: dict[str, int] = defaultdict(int)
        self._waiters: dict[
            str, set[tuple[asyncio.AbstractEventLoop, asyncio.Future[int]]]
        ] = defaultdict(set)
        self._observers: dict[str, int] = defaultdict(int)
        self._closed = False
        self._published = 0
        self._waits = 0
        self._woken = 0
        self._timed_out = 0

    @property
    def waiter_count(self) -> int:
        with self._lock:
            return sum(len(waiters) for waiters in self._waiters.values())

    def version(self, key: str) -> int:
        with self._lock:
            return self._versions.get(key, 0)

    @contextmanager
    def observe(self, key: str) -> Iterator[int]:
        """Keep one key alive across the durable-read-before-wait window."""
        with self._lock:
            self._observers[key] += 1
            version = self._versions.get(key, 0)
        try:
            yield version
        finally:
            with self._lock:
                remaining = self._observers.get(key, 0) - 1
                if remaining > 0:
                    self._observers[key] = remaining
                else:
                    self._observers.pop(key, None)
                    if not self._waiters.get(key):
                        self._versions.pop(key, None)

    def stats(self) -> dict[str, int]:
        with self._lock:
            return {
                "published": self._published,
                "waits": self._waits,
                "woken": self._woken,
                "timedOut": self._timed_out,
                "activeWaiters": sum(
                    len(waiters) for waiters in self._waiters.values()
                ),
                "activeKeys": len(set(self._observers) | set(self._waiters)),
            }

    def publish(self, key: str) -> None:
        with self._lock:
            if self._closed:
                return
            self._published += 1
            version = self._versions.get(key, 0) + 1
            waiters = list(self._waiters.pop(key, ()))
            if self._observers.get(key) or waiters:
                self._versions[key] = version
        for loop, future in waiters:
            try:
                loop.call_soon_threadsafe(self._resolve, future, version)
            except RuntimeError:
                # The request loop may have closed while a database commit was
                # completing. The durable recovery read remains authoritative.
                continue

    async def wait(self, key: str, after_version: int, *, timeout: float) -> bool:
        if timeout <= 0:
            return False
        loop = asyncio.get_running_loop()
        future: asyncio.Future[int] = loop.create_future()
        waiter = (loop, future)
        with self._lock:
            self._waits += 1
            if self._closed:
                return False
            if self._versions[key] > after_version:
                self._woken += 1
                return True
            self._waiters[key].add(waiter)
        try:
            version = await asyncio.wait_for(future, timeout=timeout)
            woken = version > after_version
            if woken:
                with self._lock:
                    self._woken += 1
            return woken
        except TimeoutError:
            with self._lock:
                self._timed_out += 1
            return False
        finally:
            with self._lock:
                waiters = self._waiters.get(key)
                if waiters is not None:
                    waiters.discard(waiter)
                    if not waiters:
                        self._waiters.pop(key, None)
                        if not self._observers.get(key):
                            self._versions.pop(key, None)

    def close(self) -> None:
        with self._lock:
            if self._closed:
                return
            self._closed = True
            waiters = [waiter for values in self._waiters.values() for waiter in values]
            self._waiters.clear()
            self._observers.clear()
            self._versions.clear()
        for loop, future in waiters:
            try:
                loop.call_soon_threadsafe(self._resolve, future, 0)
            except RuntimeError:
                continue

    @staticmethod
    def _resolve(future: asyncio.Future[int], version: int) -> None:
        if not future.done():
            future.set_result(version)


class PostgresNotificationBridge:
    """Forward committed PostgreSQL notifications into a local notifier."""

    def __init__(
        self,
        database_url: str,
        notifier: KeyedEventNotifier,
        *,
        channel: str = CONTROL_PLANE_NOTIFICATION_CHANNEL,
    ) -> None:
        url = make_url(database_url)
        self.database_url = url.set(drivername="postgresql").render_as_string(
            hide_password=False
        )
        self.notifier = notifier
        self.channel = channel
        self._task: asyncio.Task[None] | None = None
        self._connected = False
        self._reconnects = 0
        self._notifications = 0

    def stats(self) -> dict[str, int | bool]:
        return {
            "enabled": True,
            "connected": self._connected,
            "reconnects": self._reconnects,
            "notifications": self._notifications,
        }

    def start(self) -> None:
        if self._task and not self._task.done():
            return
        self._task = asyncio.create_task(
            self._run(), name="relay-postgres-notification-bridge"
        )

    async def stop(self) -> None:
        if not self._task:
            return
        self._task.cancel()
        try:
            await self._task
        except asyncio.CancelledError:
            pass
        self._task = None

    async def _run(self) -> None:
        retry_seconds = 0.25
        while True:
            try:
                connection = await psycopg.AsyncConnection.connect(
                    self.database_url, autocommit=True
                )
                async with connection:
                    self._connected = True
                    await connection.execute(
                        sql.SQL("LISTEN {}").format(sql.Identifier(self.channel))
                    )
                    retry_seconds = 0.25
                    while True:
                        async for notification in connection.notifies(timeout=30):
                            self._notifications += 1
                            self.notifier.publish(notification.payload)
            except asyncio.CancelledError:
                raise
            except (OSError, psycopg.Error) as error:
                self._connected = False
                self._reconnects += 1
                logger.warning(
                    "PostgreSQL notification bridge disconnected",
                    error=str(error),
                    retry_seconds=retry_seconds,
                )
                await asyncio.sleep(retry_seconds)
                retry_seconds = min(retry_seconds * 2, 5.0)


def database_notification_bridge(
    store: Any, notifier: KeyedEventNotifier
) -> PostgresNotificationBridge | None:
    engine = getattr(store, "engine", None)
    if engine is None or engine.dialect.name != "postgresql":
        return None
    return PostgresNotificationBridge(
        engine.url.render_as_string(hide_password=False), notifier
    )
