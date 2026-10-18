"""The change hint a store fires after a write commits.

A listener wakes requests waiting on a key (an SSE stream, a daemon long-poll)
in this process; ``database_channel`` names the PostgreSQL NOTIFY channel that
wakes the other replicas. A hint is best-effort: a failing callback is logged
and never fails the write that fired it.
"""

from __future__ import annotations

from collections.abc import Callable

from loguru import logger


class ChangeListener:
    def __init__(self, what: str) -> None:
        self._what = what
        self._callback: Callable[[str], None] | None = None
        self.database_channel: str | None = None

    def attach(self, callback: Callable[[str], None], database_channel: str | None = None) -> None:
        self._callback = callback
        self.database_channel = database_channel

    def fire(self, key: str) -> None:
        if not self._callback:
            return
        try:
            self._callback(key)
        except Exception:  # noqa: BLE001 - notification hints must not fail writes
            logger.exception(f"{self._what} listener failed", key=key)
