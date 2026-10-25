from __future__ import annotations

import threading
import time
import weakref
from collections import Counter
from collections.abc import Callable
from datetime import UTC, datetime, timedelta, tzinfo
from typing import Any
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from fastapi import APIRouter, Request

from ...core.token_usage import split_cache_tokens
from ...security.request_auth import require_admin_session
from ..deps import AppContextDep

router = APIRouter()


# ── Dashboard ────────────────────────────────────────────────────────────
# Aggregated, read-only stats for the admin Dashboard view, built on the
# session store and its per-run token-usage ledger.

_DAY_WINDOW = 14
_SUMMARY_DAYS = 7
_TOKEN_KEYS = ("input", "output", "cacheRead", "cacheWrite")
# The dashboard is admin-only and its windows span days, so an answer a few
# seconds old is as good as a fresh one; both endpoints walk their whole
# window, which this keeps off the hot path while the page polls.
DASHBOARD_CACHE_TTL_SECONDS = 30.0


class DashboardCache:
    """Per-store, per-(endpoint, zone, window) answers with a short TTL.

    Keyed weakly on the session store so each app (every test builds its own)
    has its own entries and a discarded store takes them with it.
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
        self._entries: weakref.WeakKeyDictionary[Any, dict[tuple[Any, ...], tuple[float, Any]]]
        self._entries = weakref.WeakKeyDictionary()

    def get_or_build(
        self, store: Any, key: tuple[Any, ...], build: Callable[[], dict[str, Any]]
    ) -> dict[str, Any]:
        now = self._clock()
        with self._lock:
            entry = self._entries.get(store, {}).get(key)
            if entry is not None and entry[0] > now:
                return entry[1]
        value = build()
        with self._lock:
            self._entries.setdefault(store, {})[key] = (now + self.ttl_seconds, value)
        return value

    def clear(self) -> None:
        with self._lock:
            self._entries.clear()


DASHBOARD_CACHE = DashboardCache()


def _parse_timestamp(value: Any) -> datetime | None:
    if not isinstance(value, str) or not value:
        return None
    raw = value.replace("Z", "+00:00")
    try:
        parsed = datetime.fromisoformat(raw)
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=UTC)
    return parsed.astimezone(UTC)


@router.get("/admin/dashboard/sessions")
def dashboard_sessions(request: Request, ctx: AppContextDep) -> dict[str, Any]:
    require_admin_session(request, ctx.auth_store)
    return DASHBOARD_CACHE.get_or_build(
        ctx.session_store,
        ("sessions", _DAY_WINDOW),
        lambda: _session_metrics(ctx.session_store),
    )


def _session_metrics(session_store: Any) -> dict[str, Any]:
    if hasattr(session_store, "dashboard_session_metrics"):
        return session_store.dashboard_session_metrics(day_window=_DAY_WINDOW)
    sessions = session_store.list_sessions()
    now = datetime.now(UTC)
    window_start = (now - timedelta(days=_DAY_WINDOW - 1)).date()

    buckets: dict[str, dict[str, int]] = {
        (window_start + timedelta(days=offset)).isoformat(): {"count": 0, "completed": 0, "failed": 0}
        for offset in range(_DAY_WINDOW)
    }

    total = len(sessions)
    last_24h = 0
    last_7d = 0
    status_counts: Counter[str] = Counter()
    per_user: Counter[str] = Counter()

    one_day = now - timedelta(hours=24)
    seven_day = now - timedelta(days=7)

    for session in sessions:
        created = _parse_timestamp(session.get("createdAt"))
        status = str(session.get("status") or "unknown")
        status_counts[status] += 1
        owner = session.get("ownerUserId")
        if owner:
            per_user[str(owner)] += 1
        if created is None:
            continue
        if created >= one_day:
            last_24h += 1
        if created >= seven_day:
            last_7d += 1
        day_key = created.date().isoformat()
        if day_key in buckets:
            bucket = buckets[day_key]
            bucket["count"] += 1
            if status == "completed":
                bucket["completed"] += 1
            elif status == "failed":
                bucket["failed"] += 1

    daily_counts = [{"date": day, **stats} for day, stats in buckets.items()]
    top_users = [
        {"userId": user_id, "sessionCount": count}
        for user_id, count in per_user.most_common(5)
    ]

    return {
        "total": total,
        "last24h": last_24h,
        "last7d": last_7d,
        "statusCounts": dict(status_counts),
        "dailyCounts": daily_counts,
        "topUsers": top_users,
    }


@router.get("/admin/dashboard/tokens")
def dashboard_tokens(
    request: Request, ctx: AppContextDep, tz: str | None = None
) -> dict[str, Any]:
    """Token usage per calendar day in the viewer's time zone (``tz``).

    The headline is fresh tokens — input, output, and cache writes. Cache reads
    are reported beside it but kept out of the headline: they dominate a long
    agent run's total while costing a tenth of input.
    """
    require_admin_session(request, ctx.auth_store)
    zone = _dashboard_zone(tz)
    return DASHBOARD_CACHE.get_or_build(
        ctx.session_store,
        ("tokens", str(zone), _DAY_WINDOW, _SUMMARY_DAYS),
        lambda: _token_metrics(ctx.session_store, zone),
    )


def _token_metrics(session_store: Any, zone: tzinfo) -> dict[str, Any]:
    today = datetime.now(zone).date()
    window_start = today - timedelta(days=_DAY_WINDOW - 1)
    summary_start = today - timedelta(days=_SUMMARY_DAYS - 1)
    usage_since = datetime.combine(window_start, datetime.min.time(), tzinfo=zone)
    usage_rows = (
        session_store.list_dashboard_token_usage(since=usage_since)
        if hasattr(session_store, "list_dashboard_token_usage")
        else session_store.list_token_usage()
    )
    buckets = {
        (window_start + timedelta(days=offset)).isoformat(): _empty_token_counts()
        for offset in range(_DAY_WINDOW)
    }
    totals = _empty_token_counts()
    unreported: Counter[str] = Counter()
    for row in usage_rows:
        timestamp = _parse_timestamp(row.get("completedAt") or row.get("updatedAt"))
        if timestamp is None:
            continue
        day = timestamp.astimezone(zone).date()
        in_summary = day >= summary_start
        if row.get("reported") is False:
            if in_summary and row.get("agent"):
                unreported[str(row["agent"])] += 1
            continue
        usage = _token_usage(row)
        if not usage:
            continue
        bucket = buckets.get(day.isoformat())
        if bucket is not None:
            _add_token_counts(bucket, usage)
        if in_summary:
            _add_token_counts(totals, usage)
    daily: list[dict[str, Any]] = [
        {"date": day, **_with_derived_counts(counts)} for day, counts in buckets.items()
    ]
    summary = _with_derived_counts(totals)
    return {
        "available": any(point["total"] > 0 for point in daily),
        "timeZone": str(zone),
        "totalInput": summary["input"],
        "totalOutput": summary["output"],
        "totalCacheRead": summary["cacheRead"],
        "totalCacheWrite": summary["cacheWrite"],
        "totalCache": summary["cache"],
        "total": summary["total"],
        "fresh": summary["fresh"],
        "daily": daily,
        "unreportedRuns": [
            {"agent": agent, "runs": runs} for agent, runs in unreported.most_common()
        ],
    }


def _dashboard_zone(name: str | None) -> tzinfo:
    if not name or len(name) > 64:
        return UTC
    try:
        return ZoneInfo(name)
    except (ZoneInfoNotFoundError, ValueError):
        return UTC


def _empty_token_counts() -> dict[str, int]:
    return dict.fromkeys(_TOKEN_KEYS, 0)


def _add_token_counts(target: dict[str, int], usage: dict[str, int]) -> None:
    for key in _TOKEN_KEYS:
        target[key] += usage[key]


def _with_derived_counts(counts: dict[str, int]) -> dict[str, int]:
    cache = counts["cacheRead"] + counts["cacheWrite"]
    fresh = counts["input"] + counts["output"] + counts["cacheWrite"]
    return {**counts, "cache": cache, "total": fresh + counts["cacheRead"], "fresh": fresh}


def _token_usage(value: Any) -> dict[str, int] | None:
    if not isinstance(value, dict):
        return None
    cache_read, cache_write = split_cache_tokens(value)
    usage = {
        "input": int(value.get("input") or 0),
        "output": int(value.get("output") or 0),
        "cacheRead": cache_read,
        "cacheWrite": cache_write,
    }
    return usage if any(usage.values()) else None
