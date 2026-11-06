"""Dashboard metrics aggregated in storage without hydrating run histories."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta, tzinfo
from typing import Any

from sqlalchemy import case, func, select

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
        self, *, zone: tzinfo, day_window: int = 14, summary_days: int = 7, now: datetime | None = None
    ) -> dict[str, Any]:
        """Transfer one row per day/runtime group, rather than one per run.

        UTC boundaries for local calendar midnights preserve 23/25-hour days
        on both SQLite and PostgreSQL without database timezone extensions.
        Future observations retain their historical summary-only treatment.
        """
        if not 1 <= summary_days <= day_window:
            raise ValueError("Dashboard windows require 1 <= summary_days <= day_window.")
        today = (now or datetime.now(zone)).astimezone(zone).date()
        start = today - timedelta(days=day_window - 1)
        dates = [start + timedelta(days=index) for index in range(day_window + 1)]
        boundaries = [datetime.combine(day, datetime.min.time(), tzinfo=zone).astimezone(UTC) for day in dates]
        ledger = self.run_token_usage.c
        day = case(*[
            (ledger.completed_at < boundaries[index + 1], dates[index].isoformat())
            for index in range(day_window)
        ]).label("day")
        agent = case((ledger.reported.is_(False), ledger.agent), else_=None).label("agent")
        statement = (
            select(
                day, agent,
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
        missing = sorted(unreported, key=lambda agent: (
            -unreported[agent][0],
            -unreported[agent][1].timestamp(),
            agent,
        ))
        return {
            "available": any(counts["total"] > 0 for counts in buckets.values()),
            "timeZone": str(zone),
            "totalInput": totals["input"], "totalOutput": totals["output"],
            "totalCacheRead": totals["cacheRead"], "totalCacheWrite": totals["cacheWrite"],
            "totalCache": totals["cache"], "total": totals["total"], "fresh": totals["fresh"],
            "daily": [{"date": day, **counts} for day, counts in buckets.items()],
            "unreportedRuns": [{"agent": agent, "runs": unreported[agent][0]} for agent in missing],
        }
