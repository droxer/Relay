"""Collapse a failure that repeats into one ERROR and periodic counts.

A daemon retries a rejected event from its durable outbox, so one bad event
can fail hundreds of times a minute. Logging each failure with its traceback
floods the platform's log pipeline (Railway drops lines past 500/s) exactly
when the logs are needed. A key's first failure is logged in full; repeats go
to DEBUG, with a WARNING count at each power of ten and at most once per
``summary_seconds``. A key quiet for ``quiet_seconds`` starts over.
"""
from __future__ import annotations

import threading
import time
from collections import OrderedDict
from collections.abc import Callable, Hashable
from dataclasses import dataclass
from typing import Any

from loguru import logger

DEFAULT_QUIET_SECONDS = 600.0
DEFAULT_SUMMARY_SECONDS = 60.0
DEFAULT_MAX_KEYS = 1024


@dataclass(frozen=True)
class Occurrence:
    """One observation of a key: whether to log it, and how loudly."""

    count: int
    """Occurrences of the key since it was first seen in this window."""
    suppressed: int
    """Occurrences since the last one that was reported."""
    first: bool
    report: bool
    """The first occurrence, or a count summary is due."""


@dataclass
class _Entry:
    count: int
    reported_count: int
    last_seen: float
    last_report: float


class RepeatGate:
    """Counts occurrences per key and says which ones deserve a log line."""

    def __init__(
        self,
        *,
        quiet_seconds: float = DEFAULT_QUIET_SECONDS,
        summary_seconds: float = DEFAULT_SUMMARY_SECONDS,
        max_keys: int = DEFAULT_MAX_KEYS,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self._quiet_seconds = quiet_seconds
        self._summary_seconds = summary_seconds
        self._max_keys = max_keys
        self._clock = clock
        self._entries: OrderedDict[Hashable, _Entry] = OrderedDict()
        self._lock = threading.Lock()

    def observe(self, key: Hashable) -> Occurrence:
        now = self._clock()
        with self._lock:
            entry = self._entries.get(key)
            if entry is None or now - entry.last_seen >= self._quiet_seconds:
                self._entries[key] = _Entry(count=1, reported_count=1, last_seen=now, last_report=now)
                self._entries.move_to_end(key)
                while len(self._entries) > self._max_keys:
                    self._entries.popitem(last=False)
                return Occurrence(count=1, suppressed=0, first=True, report=True)
            entry.count += 1
            entry.last_seen = now
            self._entries.move_to_end(key)
            due = _is_power_of_ten(entry.count) or now - entry.last_report >= self._summary_seconds
            suppressed = entry.count - entry.reported_count
            if due:
                entry.reported_count = entry.count
                entry.last_report = now
            return Occurrence(count=entry.count, suppressed=suppressed, first=False, report=due)


class RepeatedFailureLog:
    """Logs a keyed failure in full once, then as counts."""

    def __init__(self, gate: RepeatGate | None = None) -> None:
        self._gate = gate or RepeatGate()

    def failure(self, message: str, key: Hashable, error: BaseException, **fields: Any) -> Occurrence:
        """Log ``error`` for ``key``; call from the ``except`` block that caught it."""
        occurrence = self._gate.observe(key)
        context = {"error_type": type(error).__name__, **fields}
        # depth=1 attributes the line to the caller, not this helper.
        log = logger.opt(depth=1)
        if occurrence.first:
            logger.opt(depth=1, exception=error).error(
                "{} ({}: {})", message, context["error_type"], _short(error), **context
            )
        elif occurrence.report:
            log.warning(
                "{} repeated: {} times in this window, {} not logged since the last report",
                message, occurrence.count, occurrence.suppressed, repeat_count=occurrence.count, **context,
            )
        else:
            log.debug("{} repeated", message, repeat_count=occurrence.count, **context)
        return occurrence


def _is_power_of_ten(count: int) -> bool:
    while count >= 10 and count % 10 == 0:
        count //= 10
    return count == 1


def _short(error: BaseException, limit: int = 200) -> str:
    text = str(error)
    return text.splitlines()[0][:limit] if text else ""
