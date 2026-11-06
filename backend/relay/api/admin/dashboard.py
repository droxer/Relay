from __future__ import annotations

from collections import Counter
from datetime import UTC, datetime, timedelta, tzinfo
from typing import Any
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from fastapi import APIRouter, Request

from ...core.token_usage import split_cache_tokens
from ...persistence.protocols import SessionStore
from ...security.request_auth import require_admin_session
from ..deps import AppContextDep
from .dashboard_cache import DashboardCache

router = APIRouter()


# ── Dashboard ────────────────────────────────────────────────────────────
# Aggregated, read-only stats for the admin Dashboard view, built on the
# session store and its per-run token-usage ledger.

_DAY_WINDOW = 14
_SUMMARY_DAYS = 7
_TOKEN_KEYS = ("input", "output", "cacheRead", "cacheWrite")
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
        lambda: ctx.session_store.dashboard_session_metrics(day_window=_DAY_WINDOW),
    )


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


def _token_metrics(session_store: SessionStore, zone: tzinfo) -> dict[str, Any]:
    today = datetime.now(zone).date()
    window_start = today - timedelta(days=_DAY_WINDOW - 1)
    summary_start = today - timedelta(days=_SUMMARY_DAYS - 1)
    usage_since = datetime.combine(window_start, datetime.min.time(), tzinfo=zone)
    usage_rows = session_store.list_dashboard_token_usage(since=usage_since)
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
