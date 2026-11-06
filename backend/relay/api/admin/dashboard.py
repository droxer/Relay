from __future__ import annotations

from datetime import UTC, tzinfo
from typing import Any
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from fastapi import APIRouter, Request

from ...security.request_auth import require_admin_session
from ..deps import AppContextDep
from .dashboard_cache import DashboardCache

router = APIRouter()


# ── Dashboard ────────────────────────────────────────────────────────────
# Aggregated, read-only stats for the admin Dashboard view, built on the
# session store and its per-run token-usage ledger.

_DAY_WINDOW = 14
_SUMMARY_DAYS = 7
DASHBOARD_CACHE = DashboardCache()


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
        lambda: ctx.session_store.dashboard_token_metrics(
            zone=zone, day_window=_DAY_WINDOW, summary_days=_SUMMARY_DAYS
        ),
    )


def _dashboard_zone(name: str | None) -> tzinfo:
    if not name or len(name) > 64:
        return UTC
    try:
        return ZoneInfo(name)
    except (ZoneInfoNotFoundError, ValueError):
        return UTC
