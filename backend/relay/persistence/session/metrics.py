"""Dashboard metrics aggregated in storage without hydrating run histories."""

from __future__ import annotations

from datetime import UTC, date, datetime, timedelta, tzinfo
from typing import Any

from sqlalchemy import case, func, select, text
from sqlalchemy.sql.elements import ColumnElement

from ..engine import store_transaction
from .state import SessionStoreState


_TOKEN_COLUMNS = {
    "input": "input_tokens",
    "output": "output_tokens",
    "cacheRead": "cache_read_tokens",
    "cacheWrite": "cache_write_tokens",
}


def _counts(values: Any = None) -> dict[str, int]:
    counts = {key: int(values[key] or 0) if values else 0 for key in _TOKEN_COLUMNS}
    cache = counts["cacheRead"] + counts["cacheWrite"]
    fresh = counts["input"] + counts["output"] + counts["cacheWrite"]
    return {**counts, "cache": cache, "total": fresh + counts["cacheRead"], "fresh": fresh}


class SessionMetricRows(SessionStoreState):
    def dashboard_token_metrics(
        self, *, zone: tzinfo, day_window: int = 14, summary_days: int = 7, now: datetime | None = None,
        date_range: tuple[date, date] | None = None
    ) -> dict[str, Any]:
        """Transfer one row per day/runtime group, rather than one per run.

        UTC boundaries for local calendar midnights preserve 23/25-hour days
        on both SQLite and PostgreSQL without database timezone extensions.
        Future observations retain their historical summary-only treatment.
        """
        if date_range:
            day_window = summary_days = (date_range[1] - date_range[0]).days + 1
        if not 1 <= summary_days <= day_window:
            raise ValueError("Dashboard windows require 1 <= summary_days <= day_window.")
        today = date_range[1] if date_range else (now or datetime.now(zone)).astimezone(zone).date()
        start = today - timedelta(days=day_window - 1)
        dates = [start + timedelta(days=index) for index in range(day_window + 1)]
        boundaries = [datetime.combine(day, datetime.min.time(), tzinfo=zone).astimezone(UTC) for day in dates]
        ledger = self.run_token_usage.c
        day = case(
            *[(ledger.completed_at < boundaries[index + 1], dates[index].isoformat()) for index in range(day_window)]
        ).label("day")
        agent = case((ledger.reported.is_(False), ledger.agent), else_=None).label("agent")
        statement = (
            select(
                day,
                agent,
                *[
                    func.sum(case((ledger.reported.is_(True), ledger[column]), else_=0)).label(key)
                    for key, column in _TOKEN_COLUMNS.items()
                ],
                func.sum(case((ledger.reported.is_(False), 1), else_=0)).label("unreported"),
                func.max(ledger.completed_at).label("latest"),
            )
            .where(ledger.completed_at >= boundaries[0])
            .group_by(day, agent)
        )
        if date_range:
            statement = statement.where(ledger.completed_at < boundaries[-1])
        with store_transaction(self.engine) as conn:
            rows = conn.execute(statement).mappings().all()
        buckets = {day.isoformat(): _counts() for day in dates[:-1]}
        totals = _counts()
        unreported: dict[str, tuple[int, datetime]] = {}
        summary_start = (today - timedelta(days=summary_days - 1)).isoformat()
        for row in rows:
            counts = _counts(row)
            if row["day"] in buckets:
                bucket = buckets[row["day"]]
                for key in bucket:
                    bucket[key] += counts[key]
            if row["day"] is None or row["day"] >= summary_start:
                for key in totals:
                    totals[key] += counts[key]
                if row["agent"] and row["unreported"]:
                    observed = row["latest"]
                    if observed.tzinfo is None:
                        observed = observed.replace(tzinfo=UTC)
                    count, latest = unreported.get(row["agent"], (0, observed))
                    unreported[row["agent"]] = (count + int(row["unreported"]), max(latest, observed))
        missing = sorted(
            unreported,
            key=lambda agent: (
                -unreported[agent][0],
                -unreported[agent][1].timestamp(),
                agent,
            ),
        )
        return {
            "available": any(counts["total"] > 0 for counts in buckets.values()),
            "timeZone": str(zone),
            "totalInput": totals["input"],
            "totalOutput": totals["output"],
            "totalCacheRead": totals["cacheRead"],
            "totalCacheWrite": totals["cacheWrite"],
            "totalCache": totals["cache"],
            "total": totals["total"],
            "fresh": totals["fresh"],
            "daily": [{"date": day, **counts} for day, counts in buckets.items()],
            "unreportedRuns": [{"agent": agent, "runs": unreported[agent][0]} for agent in missing],
        }

    def dashboard_session_metrics(
        self, *, day_window: int = 14, now: datetime | None = None,
        date_range: tuple[date, date] | None = None, zone: tzinfo = UTC,
    ) -> dict[str, Any]:
        """Aggregate dashboard counters in SQL without hydrating session events."""
        now = now or datetime.now(UTC)
        one_day = now - timedelta(hours=24)
        seven_days = now - timedelta(days=7)
        window_start = (now - timedelta(days=day_window - 1)).date()
        window_start_at = datetime.combine(window_start, datetime.min.time(), tzinfo=UTC)
        created = self.sessions.c.created_at
        filters = []
        day: ColumnElement[Any]
        if date_range:
            window_start = date_range[0]
            day_window = (date_range[1] - window_start).days + 1
            dates = [window_start + timedelta(days=index) for index in range(day_window + 1)]
            boundaries = [datetime.combine(day, datetime.min.time(), tzinfo=zone).astimezone(UTC) for day in dates]
            window_start_at = boundaries[0]
            filters = [created >= boundaries[0], created < boundaries[-1]]
            day = case(*[(created < boundaries[index + 1], dates[index].isoformat()) for index in range(day_window)])
        else:
            day = func.date(created)
        completed = func.sum(case((self.sessions.c.status == "completed", 1), else_=0))
        failed = func.sum(case((self.sessions.c.status == "failed", 1), else_=0))
        with store_transaction(self.engine) as conn:
            # Totals, both windows, and the status breakdown in one grouped pass.
            status_rows = conn.execute(
                select(
                    self.sessions.c.status,
                    func.count(),
                    func.sum(case((created >= one_day, 1), else_=0)),
                    func.sum(case((created >= seven_days, 1), else_=0)),
                ).where(*filters).group_by(self.sessions.c.status)
            ).all()
            total = sum(int(row[1] or 0) for row in status_rows)
            last_24h = sum(int(row[2] or 0) for row in status_rows)
            last_7d = sum(int(row[3] or 0) for row in status_rows)
            user_rows = conn.execute(
                select(self.sessions.c.owner_user_id, func.count().label("count"))
                .where(self.sessions.c.owner_user_id.is_not(None), *filters)
                .group_by(self.sessions.c.owner_user_id)
                .order_by(text("count DESC"))
                .limit(5)
            ).all()
            daily_rows = (
                conn.execute(
                    select(
                        day.label("day"),
                        func.count().label("count"),
                        completed.label("completed"),
                        failed.label("failed"),
                    )
                    .where(self.sessions.c.created_at >= window_start_at, *filters)
                    .group_by(day)
                    .order_by(day)
                )
                .mappings()
                .all()
            )
        daily_by_day = {
            str(row["day"]): {
                "count": int(row["count"] or 0),
                "completed": int(row["completed"] or 0),
                "failed": int(row["failed"] or 0),
            }
            for row in daily_rows
        }
        return {
            "total": total,
            "last24h": last_24h,
            "last7d": last_7d,
            "statusCounts": {str(row[0]): int(row[1]) for row in status_rows},
            "dailyCounts": [
                {
                    "date": (window_start + timedelta(days=offset)).isoformat(),
                    **daily_by_day.get(
                        (window_start + timedelta(days=offset)).isoformat(),
                        {"count": 0, "completed": 0, "failed": 0},
                    ),
                }
                for offset in range(day_window)
            ],
            "topUsers": [{"userId": str(user_id), "sessionCount": int(count)} for user_id, count in user_rows],
        }
