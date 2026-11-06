"""Bounded, per-store answer caching for admin dashboard polling."""

from __future__ import annotations

from collections import OrderedDict
from collections.abc import Callable
from concurrent.futures import Future
from dataclasses import dataclass, field
import threading
import time
from typing import Any
import weakref


DASHBOARD_CACHE_TTL_SECONDS = 30.0


@dataclass
class _StoreAnswers:
    completed: OrderedDict[tuple[Any, ...], tuple[float, dict[str, Any]]] = field(default_factory=OrderedDict)
    pending: dict[tuple[Any, ...], Future[dict[str, Any]]] = field(default_factory=dict)


class DashboardCache:
    """Share one build per store/key and retain at most 64 completed answers.

    Builds and waiters run outside the cache lock, allowing unrelated keys to
    progress. A clear detaches pending builds: existing callers finish, while
    subsequent requests start fresh and old results cannot repopulate the cache.
    Weak store keys keep discarded application instances collectible.
    """

    def __init__(
        self,
        *,
        ttl_seconds: float = DASHBOARD_CACHE_TTL_SECONDS,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self.ttl_seconds = ttl_seconds
        self._clock = clock
        self._lock = threading.Lock()
        self._stores: weakref.WeakKeyDictionary[Any, _StoreAnswers] = weakref.WeakKeyDictionary()

    def get_or_build(
        self, store: Any, key: tuple[Any, ...], build: Callable[[], dict[str, Any]]
    ) -> dict[str, Any]:
        with self._lock:
            state = self._stores.setdefault(store, _StoreAnswers())
            now = self._clock()
            for expired in [key for key, (deadline, _) in state.completed.items() if deadline <= now]:
                del state.completed[expired]
            entry = state.completed.get(key)
            if entry is not None:
                state.completed.move_to_end(key)
                return entry[1]
            pending = state.pending.get(key)
            owns_build = pending is None
            if pending is None:
                pending = Future()
                state.pending[key] = pending
        if not owns_build:
            return pending.result()
        try:
            value = build()
        except BaseException as error:
            # Wake every waiter even if the builder is interrupted; failures
            # are never retained, so a subsequent request can retry.
            with self._lock:
                state.pending.pop(key, None)
            pending.set_exception(error)
            raise
        with self._lock:
            state.pending.pop(key, None)
            if self._stores.get(store) is state:
                state.completed[key] = (self._clock() + self.ttl_seconds, value)
                while len(state.completed) > 64:
                    state.completed.popitem(last=False)
        pending.set_result(value)
        return value

    def clear(self) -> None:
        with self._lock:
            self._stores.clear()
