"""Dashboard polling shares expensive builds and bounds retained answers."""

from concurrent.futures import ThreadPoolExecutor
from threading import Event
import gc
import weakref

import pytest

from relay.api.admin.dashboard import DashboardCache


class Store:
    pass


def test_simultaneous_polls_share_one_build_and_other_keys_progress():
    cache, store = DashboardCache(), Store()
    started, release, second_entered, duplicate = (Event() for _ in range(4))
    answer = {"total": 1}

    def build():
        if started.is_set():
            duplicate.set()
        started.set()
        assert release.wait(5)
        return answer

    def second_poll():
        second_entered.set()
        return cache.get_or_build(store, ("sessions",), build)

    with ThreadPoolExecutor(max_workers=3) as pool:
        first = pool.submit(cache.get_or_build, store, ("sessions",), build)
        try:
            assert started.wait(5)
            second = pool.submit(second_poll)
            assert second_entered.wait(5)
            unrelated = pool.submit(cache.get_or_build, store, ("tokens", "UTC"), lambda: {"total": 2})
            assert unrelated.result(timeout=2) == {"total": 2}
            repeated = duplicate.wait(0.2)
        finally:
            release.set()
        assert first.result(timeout=5) == second.result(timeout=5) == answer
    assert not repeated, "concurrent polls repeated the same aggregate build"


def test_ttl_starts_when_build_finishes_and_expires_at_deadline():
    now = [0.0]
    cache, store = DashboardCache(ttl_seconds=10, clock=lambda: now[0]), Store()

    def slow_build():
        now[0] = 20.0
        return {"total": 1}

    assert cache.get_or_build(store, ("sessions",), slow_build) == {"total": 1}
    now[0] = 29.0
    assert cache.get_or_build(store, ("sessions",), lambda: {"total": 2}) == {"total": 1}
    now[0] = 30.0
    assert cache.get_or_build(store, ("sessions",), lambda: {"total": 3}) == {"total": 3}


def test_retained_answers_are_bounded_and_recently_used_answers_survive():
    cache, store = DashboardCache(), Store()
    for index in range(64):
        cache.get_or_build(store, (index,), lambda index=index: {"total": index})
    assert cache.get_or_build(store, (0,), lambda: {"total": -1}) == {"total": 0}
    cache.get_or_build(store, (64,), lambda: {"total": 64})
    assert cache.get_or_build(store, (0,), lambda: {"total": -1}) == {"total": 0}
    assert cache.get_or_build(store, (1,), lambda: {"total": -1}) == {"total": -1}


def test_clear_during_a_build_cannot_restore_the_old_answer():
    cache, store = DashboardCache(), Store()
    started, release = Event(), Event()

    def build():
        started.set()
        assert release.wait(5)
        return {"total": 1}

    with ThreadPoolExecutor(max_workers=1) as pool:
        old = pool.submit(cache.get_or_build, store, ("sessions",), build)
        try:
            assert started.wait(5)
            cache.clear()
            assert cache.get_or_build(store, ("sessions",), lambda: {"total": 2}) == {"total": 2}
        finally:
            release.set()
        assert old.result(timeout=5) == {"total": 1}
    assert cache.get_or_build(store, ("sessions",), lambda: {"total": 3}) == {"total": 2}


def test_failed_build_is_shared_and_next_poll_retries():
    cache, store = DashboardCache(), Store()
    started, release, second_entered, duplicate = (Event() for _ in range(4))
    error = ValueError("database unavailable")

    def build():
        if started.is_set():
            duplicate.set()
        started.set()
        assert release.wait(5)
        raise error

    def second_poll():
        second_entered.set()
        return cache.get_or_build(store, ("sessions",), build)

    with ThreadPoolExecutor(max_workers=2) as pool:
        first = pool.submit(cache.get_or_build, store, ("sessions",), build)
        try:
            assert started.wait(5)
            second = pool.submit(second_poll)
            assert second_entered.wait(5)
            repeated = duplicate.wait(0.2)
        finally:
            release.set()
        for result in (first, second):
            with pytest.raises(ValueError) as raised:
                result.result(timeout=5)
            assert raised.value is error
    assert not repeated
    assert cache.get_or_build(store, ("sessions",), lambda: {"total": 2}) == {"total": 2}


def test_answers_are_isolated_by_store_and_do_not_keep_stores_alive():
    cache = DashboardCache()
    first, second = Store(), Store()
    cache.get_or_build(first, ("sessions",), lambda: {"total": 1})
    assert cache.get_or_build(second, ("sessions",), lambda: {"total": 2}) == {"total": 2}
    reference = weakref.ref(first)
    del first
    gc.collect()
    assert reference() is None
