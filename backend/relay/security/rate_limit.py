from __future__ import annotations

import math
import os
import time
from dataclasses import dataclass
from threading import Lock


@dataclass
class _Window:
    attempts: int
    reset_at: float


class AuthRateLimiter:
    """Small per-process limiter for expensive authentication checks.

    Deployments with multiple control-plane replicas should additionally rate
    limit at the edge. This local guard still prevents one process from being
    used as an unbounded PBKDF2 worker.
    """

    def __init__(self, *, attempts: int | None = None, window_seconds: int | None = None):
        self.attempts = max(
            1,
            attempts
            if attempts is not None
            else _positive_int("RELAY_AUTH_RATE_LIMIT_ATTEMPTS", 5),
        )
        self.window_seconds = max(
            1,
            window_seconds
            if window_seconds is not None
            else _positive_int("RELAY_AUTH_RATE_LIMIT_WINDOW_SECONDS", 60),
        )
        self._windows: dict[str, _Window] = {}
        self._lock = Lock()

    def consume(self, key: str) -> int | None:
        """Record an attempt, returning Retry-After seconds when blocked."""
        now = time.monotonic()
        with self._lock:
            window = self._windows.get(key)
            if window is None or window.reset_at <= now:
                self._windows[key] = _Window(1, now + self.window_seconds)
                return None
            if window.attempts >= self.attempts:
                return max(1, math.ceil(window.reset_at - now))
            window.attempts += 1
            return None

    def retry_after(self, key: str) -> int | None:
        """Retry-After seconds when ``key`` is blocked, without recording an attempt."""
        now = time.monotonic()
        with self._lock:
            window = self._windows.get(key)
            if window is None or window.reset_at <= now or window.attempts < self.attempts:
                return None
            return max(1, math.ceil(window.reset_at - now))

    def reset(self, key: str) -> None:
        with self._lock:
            self._windows.pop(key, None)


def _positive_int(name: str, default: int) -> int:
    try:
        value = int(os.environ.get(name, ""))
    except ValueError:
        return default
    return value if value > 0 else default
