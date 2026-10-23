"""Process-local caches in front of the account store's per-request reads.

Every authenticated request resolved its session cookie with two store reads
(the session by token hash, then the account), and ``GET /auth/status`` asked
whether any account exists on every poll. Both answers change rarely, so each
is kept here for a short while:

- ``SESSION_ACCOUNTS`` maps a session token hash to the account it resolved
  to for ``SESSION_ACCOUNT_TTL_SECONDS``. The store's mutating methods drop
  it (one token on logout, everything on an account or user change), so a
  change made through this process is visible at once; a change made on
  another replica is visible within the TTL.
- ``accounts_known_to_exist`` remembers, per store, that at least one account
  exists. Accounts are never all deleted, so ``True`` never goes stale.

Only hashes are kept, never a token, and entries are copied on the way in and
out so a caller mutating its account dict cannot poison the next request.
"""

from __future__ import annotations

import threading
import time
import weakref
from collections.abc import Callable
from typing import Any

SESSION_ACCOUNT_TTL_SECONDS = 10.0
# Bound the cache so a flood of invalid tokens cannot grow it: only resolved
# sessions are kept, and a signed-in population past this is evicted oldest
# first.
SESSION_ACCOUNT_CACHE_MAX_ENTRIES = 4096


class SessionAccountCache:
    """A bounded TTL map from session token hash to the resolved account."""

    def __init__(
        self,
        *,
        ttl_seconds: float = SESSION_ACCOUNT_TTL_SECONDS,
        max_entries: int = SESSION_ACCOUNT_CACHE_MAX_ENTRIES,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self.ttl_seconds = ttl_seconds
        self.max_entries = max_entries
        self._clock = clock
        self._lock = threading.Lock()
        self._entries: dict[str, tuple[float, dict[str, Any]]] = {}

    def get(self, token_hash: str) -> dict[str, Any] | None:
        with self._lock:
            entry = self._entries.get(token_hash)
            if entry is None:
                return None
            expires_at, account = entry
            if expires_at <= self._clock():
                del self._entries[token_hash]
                return None
            return dict(account)

    def put(self, token_hash: str, account: dict[str, Any]) -> None:
        with self._lock:
            if token_hash not in self._entries and len(self._entries) >= self.max_entries:
                oldest = next(iter(self._entries))
                del self._entries[oldest]
            self._entries[token_hash] = (self._clock() + self.ttl_seconds, dict(account))

    def invalidate_token(self, token_hash: str) -> None:
        with self._lock:
            self._entries.pop(token_hash, None)

    def invalidate_all(self) -> None:
        with self._lock:
            self._entries.clear()

    def __len__(self) -> int:
        with self._lock:
            return len(self._entries)


SESSION_ACCOUNTS = SessionAccountCache()

_STORES_WITH_ACCOUNTS: weakref.WeakSet[Any] = weakref.WeakSet()
_STORES_LOCK = threading.Lock()


def accounts_known_to_exist(auth_store: Any) -> bool:
    """Whether ``auth_store`` has been seen with at least one account."""
    with _STORES_LOCK:
        return auth_store in _STORES_WITH_ACCOUNTS


def remember_accounts_exist(auth_store: Any) -> None:
    with _STORES_LOCK:
        _STORES_WITH_ACCOUNTS.add(auth_store)


def has_accounts_cached(auth_store: Any) -> bool:
    """``auth_store.has_accounts()``, asked once per store until it says yes."""
    if accounts_known_to_exist(auth_store):
        return True
    found = bool(auth_store.has_accounts())
    if found:
        remember_accounts_exist(auth_store)
    return found
