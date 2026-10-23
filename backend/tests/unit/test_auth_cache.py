"""The per-request session cache in front of the account store."""

from __future__ import annotations

from relay.security.auth_cache import (
    SessionAccountCache,
    accounts_known_to_exist,
    has_accounts_cached,
)


class _Clock:
    def __init__(self) -> None:
        self.now = 100.0

    def __call__(self) -> float:
        return self.now


def test_cached_account_is_served_until_the_ttl_passes() -> None:
    clock = _Clock()
    cache = SessionAccountCache(ttl_seconds=10.0, clock=clock)
    cache.put("hash-1", {"id": "acct_1", "role": "user"})

    assert cache.get("hash-1") == {"id": "acct_1", "role": "user"}
    clock.now += 9.9
    assert cache.get("hash-1") is not None
    clock.now += 0.2
    assert cache.get("hash-1") is None
    assert len(cache) == 0


def test_cached_account_is_copied_both_ways() -> None:
    cache = SessionAccountCache()
    account = {"id": "acct_1", "role": "user"}
    cache.put("hash-1", account)
    account["role"] = "admin"

    served = cache.get("hash-1")
    assert served == {"id": "acct_1", "role": "user"}
    served["role"] = "admin"
    assert cache.get("hash-1") == {"id": "acct_1", "role": "user"}


def test_invalidation_drops_one_token_or_everything() -> None:
    cache = SessionAccountCache()
    cache.put("hash-1", {"id": "a"})
    cache.put("hash-2", {"id": "b"})

    cache.invalidate_token("hash-1")
    assert cache.get("hash-1") is None
    assert cache.get("hash-2") == {"id": "b"}

    cache.invalidate_all()
    assert cache.get("hash-2") is None


def test_cache_is_bounded_and_evicts_the_oldest_entry() -> None:
    cache = SessionAccountCache(max_entries=2)
    cache.put("hash-1", {"id": "a"})
    cache.put("hash-2", {"id": "b"})
    cache.put("hash-3", {"id": "c"})

    assert cache.get("hash-1") is None
    assert cache.get("hash-2") == {"id": "b"}
    assert cache.get("hash-3") == {"id": "c"}


class _Store:
    def __init__(self, answers: list[bool]) -> None:
        self.answers = answers
        self.calls = 0

    def has_accounts(self) -> bool:
        self.calls += 1
        return self.answers.pop(0)


def test_has_accounts_is_asked_until_the_store_says_yes_then_remembered() -> None:
    store = _Store([False, False, True, False])

    assert has_accounts_cached(store) is False
    assert has_accounts_cached(store) is False
    assert has_accounts_cached(store) is True
    assert has_accounts_cached(store) is True
    assert store.calls == 3
    assert accounts_known_to_exist(store)

    # Another store (another app, another database) starts from scratch.
    other = _Store([False])
    assert has_accounts_cached(other) is False
    assert not accounts_known_to_exist(other)
