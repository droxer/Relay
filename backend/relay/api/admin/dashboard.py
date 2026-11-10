from __future__ import annotations

from datetime import UTC, date, datetime, timedelta, tzinfo
from typing import Any
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from fastapi import APIRouter, HTTPException, Request

from ...security.request_auth import require_admin_session
from ..deps import AppContextDep
from .dashboard_cache import DashboardCache

router = APIRouter()


# ── Dashboard ────────────────────────────────────────────────────────────
# Aggregated, read-only stats for the admin Dashboard view, built on the
# session store and its per-run token-usage ledger.

DASHBOARD_CACHE = DashboardCache()


@router.get("/admin/dashboard/sessions")
def dashboard_sessions(
    request: Request, ctx: AppContextDep, start: date | None = None,
    end: date | None = None, tz: str | None = None,
) -> dict[str, Any]:
    require_admin_session(request, ctx.auth_store)
    zone = _dashboard_zone(tz)
    period = _dashboard_period(start, end, zone)
    return DASHBOARD_CACHE.get_or_build(
        ctx.session_store,
        ("sessions", str(zone), *period),
        lambda: ctx.session_store.dashboard_session_metrics(date_range=period, zone=zone),
    )


@router.get("/admin/dashboard/tokens")
def dashboard_tokens(
    request: Request, ctx: AppContextDep, tz: str | None = None,
    start: date | None = None, end: date | None = None
) -> dict[str, Any]:
    """Token usage per calendar day in the viewer's time zone (``tz``).

    The headline is fresh tokens — input, output, and cache writes. Cache reads
    are reported beside it but kept out of the headline: they dominate a long
    agent run's total while costing a tenth of input.
    """
    require_admin_session(request, ctx.auth_store)
    zone = _dashboard_zone(tz)
    period = _dashboard_period(start, end, zone)
    return DASHBOARD_CACHE.get_or_build(
        ctx.session_store,
        ("tokens", str(zone), *period),
        lambda: ctx.session_store.dashboard_token_metrics(
            zone=zone, date_range=period
        ),
    )


def _dashboard_zone(name: str | None) -> tzinfo:
    if not name or len(name) > 64:
        return UTC
    try:
        return ZoneInfo(name)
    except (ZoneInfoNotFoundError, ValueError):
        return UTC


def _dashboard_period(start: date | None, end: date | None, zone: tzinfo) -> tuple[date, date]:
    if start is None and end is None:
        end = datetime.now(zone).date()
        return end - timedelta(days=6), end
    if (
        start is None or end is None or not date.min < start <= end < date.max
        or not 0 <= (end - start).days < 366
    ):
        raise HTTPException(422, "Choose both dates in order, covering at most 366 days.")
    return start, end
