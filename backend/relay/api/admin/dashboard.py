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


@router.get("/admin/dashboard/agents")
def dashboard_agents(request: Request, ctx: AppContextDep) -> dict[str, int]:
    require_admin_session(request, ctx.auth_store)
    return DASHBOARD_CACHE.get_or_build(
        ctx.agent_store, ("agents",), lambda: {"count": ctx.agent_store.count_live_agents()},
    )


@router.get("/admin/dashboard/sessions")
def dashboard_sessions(
    request: Request, ctx: AppContextDep, start: date | None = None,
    end: date | None = None, tz: str | None = None, all_time: bool = False,
) -> dict[str, Any]:
    require_admin_session(request, ctx.auth_store)
    zone = _dashboard_zone(tz)
    period = _dashboard_period(start, end, zone, all_time=all_time)

    def build() -> dict[str, Any]:
        metrics = ctx.session_store.dashboard_session_metrics(date_range=period, zone=zone, all_time=all_time)
        ranked = metrics["topUsers"]
        labels = ctx.auth_store.user_labels([row["userId"] for row in ranked])
        return {**metrics, "topUsers": [{**row, **labels.get(row["userId"], {})} for row in ranked]}

    return DASHBOARD_CACHE.get_or_build(
        ctx.session_store,
        ("sessions", str(zone), period),
        build,
    )


@router.get("/admin/dashboard/tokens")
def dashboard_tokens(
    request: Request, ctx: AppContextDep, tz: str | None = None,
    start: date | None = None, end: date | None = None, all_time: bool = False,
) -> dict[str, Any]:
    """Token usage per calendar day in the viewer's time zone (``tz``).

    The headline is fresh tokens — input, output, and cache writes. Cache reads
    are reported beside it but kept out of the headline: they dominate a long
    agent run's total while costing a tenth of input.
    """
    require_admin_session(request, ctx.auth_store)
    zone = _dashboard_zone(tz)
    period = _dashboard_period(start, end, zone, all_time=all_time)
    return DASHBOARD_CACHE.get_or_build(
        ctx.session_store,
        ("tokens", str(zone), period),
        lambda: ctx.session_store.dashboard_token_metrics(
            zone=zone, date_range=period, all_time=all_time
        ),
    )


@router.get("/admin/dashboard/work")
def dashboard_work(
    request: Request, ctx: AppContextDep, tz: str | None = None,
    start: date | None = None, end: date | None = None, all_time: bool = False,
) -> dict[str, Any]:
    """Project, task, and conversation totals for the admin Dashboard view."""
    require_admin_session(request, ctx.auth_store)
    zone = _dashboard_zone(tz)
    period = _dashboard_period(start, end, zone, all_time=all_time)
    zone_key = str(zone)
    projects = DASHBOARD_CACHE.get_or_build(
        ctx.project_store,
        ("projects", zone_key, period),
        lambda: ctx.project_store.dashboard_project_metrics(
            date_range=period, zone=zone, all_time=all_time
        ),
    )
    tasks = DASHBOARD_CACHE.get_or_build(
        ctx.task_store,
        ("tasks", zone_key, period),
        lambda: ctx.task_store.dashboard_task_metrics(
            date_range=period, zone=zone, all_time=all_time
        ),
    )
    conversations = DASHBOARD_CACHE.get_or_build(
        ctx.session_store,
        ("conversations", zone_key, period),
        lambda: ctx.session_store.dashboard_conversation_metrics(
            date_range=period, zone=zone, all_time=all_time
        ),
    )
    return {"projects": projects, "tasks": tasks, "conversations": conversations}


def _dashboard_zone(name: str | None) -> tzinfo:
    if not name or len(name) > 64:
        return UTC
    try:
        return ZoneInfo(name)
    except (ZoneInfoNotFoundError, ValueError):
        return UTC


def _dashboard_period(
    start: date | None, end: date | None, zone: tzinfo, *, all_time: bool = False,
) -> tuple[date, date] | None:
    if all_time:
        if start is not None or end is not None:
            raise HTTPException(422, "All time cannot be combined with explicit dates.")
        return None
    if start is None and end is None:
        end = datetime.now(zone).date()
        return end - timedelta(days=6), end
    if (
        start is None or end is None or not date.min < start <= end < date.max
        or not 0 <= (end - start).days < 366
    ):
        raise HTTPException(422, "Choose both dates in order, covering at most 366 days.")
    return start, end
