"""Personal activity summary for the signed-in user's Home page."""

from __future__ import annotations

from datetime import UTC, date, datetime, timedelta, tzinfo
from typing import Any
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from fastapi import APIRouter, HTTPException, Request

from ...security.request_auth import require_user_session
from ..deps import AppContextDep

router = APIRouter()

HOME_STATS_PERIODS = frozenset({"week", "30d", "all"})


@router.get("/home/stats")
def home_stats(
    request: Request,
    ctx: AppContextDep,
    period: str = "week",
    tz: str | None = None,
) -> dict[str, Any]:
    """Return the signed-in user's tasks, conversations, runs, and token usage."""
    account = require_user_session(request, ctx.auth_store)
    user_id = account.get("userId")
    if not isinstance(user_id, str) or not user_id:
        raise HTTPException(409, "This account has no linked user.")
    if period not in HOME_STATS_PERIODS:
        raise HTTPException(422, "period must be one of: week, 30d, all.")
    zone = _resolve_zone(tz)
    all_time = period == "all"
    date_range = None if all_time else _period_range(period, zone)

    tasks = ctx.task_store.user_home_task_stats(
        user_id, date_range=date_range, zone=zone, all_time=all_time,
    )
    conversations = ctx.session_store.dashboard_conversation_metrics(
        date_range=date_range, zone=zone, all_time=all_time, owner_user_id=user_id,
    )
    token_metrics = ctx.session_store.dashboard_token_metrics(
        zone=zone, date_range=date_range, all_time=all_time, owner_user_id=user_id,
    )
    runtimes = token_metrics["runtimes"]
    total_runs = sum(int(row["runs"]) for row in runtimes)
    reported_runs = sum(int(row["reportedRuns"]) for row in runtimes)

    return {
        "period": period,
        "startDate": date_range[0].isoformat() if date_range else None,
        "endDate": date_range[1].isoformat() if date_range else None,
        "timeZone": str(zone),
        "tasks": tasks,
        "conversations": {
            "total": conversations["total"],
            "chats": conversations["chats"],
            "projectChats": conversations["projectChats"],
            "standaloneChats": conversations["standaloneChats"],
            "taskRuns": conversations["taskRuns"],
            "automationRuns": conversations["automationRuns"],
        },
        "runs": {
            "total": total_runs,
            "reported": reported_runs,
            "unreported": max(0, total_runs - reported_runs),
            "runtimes": runtimes,
        },
        "tokens": {
            "available": token_metrics["available"],
            "bucketSize": token_metrics["bucketSize"],
            "fresh": token_metrics["fresh"],
            "input": token_metrics["totalInput"],
            "output": token_metrics["totalOutput"],
            "cacheWrite": token_metrics["totalCacheWrite"],
            "cacheRead": token_metrics["totalCacheRead"],
            "cache": token_metrics["totalCache"],
            "total": token_metrics["total"],
            "daily": token_metrics["daily"],
            "unreportedRuns": token_metrics["unreportedRuns"],
        },
    }


def _resolve_zone(name: str | None) -> tzinfo:
    if not name or len(name) > 64:
        return UTC
    try:
        return ZoneInfo(name)
    except (ZoneInfoNotFoundError, ValueError):
        return UTC


def _period_range(period: str, zone: tzinfo, *, now: datetime | None = None) -> tuple[date, date]:
    today = (now or datetime.now(zone)).astimezone(zone).date()
    if period == "week":
        # ISO calendar week: Monday through today in the viewer's time zone.
        return today - timedelta(days=today.weekday()), today
    # 30d: 30 calendar days ending today.
    return today - timedelta(days=29), today
