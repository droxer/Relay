"""The per-process limiter: blocking, and forgetting expired client windows."""

from __future__ import annotations

import pytest
from relay.security import rate_limit
from relay.security.rate_limit import AuthRateLimiter


def test_blocks_after_the_allowed_attempts() -> None:
    limiter = AuthRateLimiter(attempts=2, window_seconds=60)
    assert limiter.consume("ip") is None
    assert limiter.consume("ip") is None
    assert limiter.consume("ip") > 0


def test_expired_windows_are_pruned(monkeypatch: pytest.MonkeyPatch) -> None:
    clock = [1000.0]
    monkeypatch.setattr(rate_limit.time, "monotonic", lambda: clock[0])
    monkeypatch.setattr(rate_limit, "_PRUNE_THRESHOLD", 3)
    limiter = AuthRateLimiter(attempts=1, window_seconds=10)
    for key in ("a", "b", "c"):
        limiter.consume(key)
    clock[0] += 11

    limiter.consume("d")

    assert set(limiter._windows) == {"d"}
