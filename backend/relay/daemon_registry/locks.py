"""The registry's two lock levels, with their order enforced.

``dispatch_lock`` serializes registry-wide mutations (admission, terminal
events, reaping). ``dispatch_scope(node_ids)`` serializes one node's
mutations without blocking the others; streamed output takes only that. The
order is global, then node: a thread holding a node lock must never wait for
the global one, or two threads can each hold what the other needs. The
``GlobalDispatchLock`` raises instead of risking that deadlock.
"""

from __future__ import annotations

import threading
from collections.abc import Callable
from types import TracebackType


class LockOrderError(RuntimeError):
    """The global dispatch lock was requested while holding only a node lock."""


class GlobalDispatchLock:
    """A reentrant lock that refuses to be taken under a node lock it outranks."""

    def __init__(self, node_locks_held: Callable[[], int]) -> None:
        self._lock = threading.RLock()
        self._depth = threading.local()
        self._node_locks_held = node_locks_held

    def _held_here(self) -> int:
        return getattr(self._depth, "value", 0)

    def acquire(self, blocking: bool = True, timeout: float = -1) -> bool:
        if not self._held_here() and self._node_locks_held():
            raise LockOrderError(
                "dispatch_lock requested while holding a node dispatch_scope; "
                "take the global lock first."
            )
        acquired = self._lock.acquire(blocking, timeout)
        if acquired:
            self._depth.value = self._held_here() + 1
        return acquired

    def release(self) -> None:
        self._depth.value = self._held_here() - 1
        self._lock.release()

    def __enter__(self) -> GlobalDispatchLock:
        self.acquire()
        return self

    def __exit__(
        self,
        exc_type: type[BaseException] | None,
        exc: BaseException | None,
        traceback: TracebackType | None,
    ) -> None:
        self.release()
