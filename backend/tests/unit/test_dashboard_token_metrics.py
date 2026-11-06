"""Token dashboard totals stay complete while ledger transfer stays grouped."""

from datetime import UTC, datetime, timedelta
from uuid import uuid4
from zoneinfo import ZoneInfo

import pytest
from sqlalchemy import event, insert

from store_fixtures import make_session_store


def seed(store, timestamp, *, count=1, agent="codex", reported=True, tokens=(10, 5, 3, 2)):
    with store.engine.begin() as conn:
        conn.execute(
            insert(store.run_token_usage),
            [
                {
                    "session_id": str(uuid4()),
                    "run_id": str(uuid4()),
                    "owner_user_id": None,
                    "task_goal": "private goal " * 1000,
                    "agent": agent,
                    "reported": reported,
                    "input_tokens": tokens[0],
                    "output_tokens": tokens[1],
                    "cache_read_tokens": tokens[2],
                    "cache_write_tokens": tokens[3],
                    "cache_tokens": tokens[2] + tokens[3],
                    "total_tokens": sum(tokens),
                    "completed_at": timestamp.astimezone(UTC),
                }
                for _ in range(count)
            ],
        )


def test_dashboard_aggregates_in_sql_without_loading_run_metadata(tmp_path):
    store = make_session_store(tmp_path)
    now = datetime(2026, 11, 6, 12, tzinfo=UTC)
    seed(store, now, count=1200)
    seed(store, now, count=30, agent="kimi", reported=False)
    statements = []

    def capture(conn, clause, *args):
        statements.append(clause)

    event.listen(store.engine, "before_execute", capture)
    try:
        result = store.dashboard_token_metrics(zone=UTC, now=now)
    finally:
        event.remove(store.engine, "before_execute", capture)
    assert result["total"] == 24000
    assert result["fresh"] == 20400
    assert result["unreportedRuns"] == [{"agent": "kimi", "runs": 30}]
    assert len(statements) == 1
    sql = str(statements[0]).lower()
    assert "group by" in sql
    assert all(field not in sql for field in ("task_goal", "session_id", "run_id", "join sessions"))
    with store.engine.connect() as conn:
        assert len(conn.execute(statements[0]).all()) == 2, "transfer grows with groups, not runs"
    # All seeded sessions are absent: ledger usage must survive thread deletion.
    ledger = store.list_token_usage()
    assert len(ledger) == 1230
    assert ledger[0]["taskGoal"] == "private goal " * 1000


@pytest.mark.parametrize(
    "zone_name,local_day,hours",
    [
        ("America/New_York", "2026-03-08", 23),
        ("America/New_York", "2026-11-01", 25),
        ("Pacific/Kiritimati", "2026-11-06", 24),
    ],
)
def test_local_midnight_boundaries_include_whole_dst_days(tmp_path, zone_name, local_day, hours):
    store = make_session_store(tmp_path)
    zone = ZoneInfo(zone_name)
    start = datetime.fromisoformat(local_day).replace(tzinfo=zone).astimezone(UTC)
    end = (datetime.fromisoformat(local_day) + timedelta(days=1)).replace(tzinfo=zone).astimezone(UTC)
    assert (end - start).total_seconds() == hours * 3600
    seed(store, start - timedelta(microseconds=1), tokens=(1, 0, 0, 0))
    seed(store, start, tokens=(10, 0, 0, 0))
    seed(store, end - timedelta(microseconds=1), tokens=(100, 0, 0, 0))
    seed(store, end, tokens=(1000, 0, 0, 0))
    result = store.dashboard_token_metrics(zone=zone, now=end + timedelta(hours=12))
    days = {day["date"]: day["total"] for day in result["daily"]}
    assert days[local_day] == 110
    assert days[(datetime.fromisoformat(local_day).date() + timedelta(days=1)).isoformat()] == 1000
    assert result["total"] == 1111
    assert result["timeZone"] == zone_name


def test_reporting_windows_and_missing_usage_preserve_totals_and_order(tmp_path):
    store = make_session_store(tmp_path)
    now = datetime(2026, 11, 6, 12, tzinfo=UTC)
    day = now.replace(hour=0)
    seed(store, day - timedelta(days=13, microseconds=1), tokens=(10000, 0, 0, 0))
    seed(store, day - timedelta(days=13), tokens=(1, 0, 0, 0))
    seed(store, day - timedelta(days=6, microseconds=1), tokens=(2, 0, 0, 0))
    seed(store, day - timedelta(days=6), tokens=(4, 0, 0, 0))
    seed(store, now, tokens=(8, 0, 0, 0))
    # Preserve the previous contract for future-dated observations: summary
    # totals include them, but the fourteen rendered dates do not.
    seed(store, day + timedelta(days=2), tokens=(16, 0, 0, 0))
    seed(store, day - timedelta(days=6, microseconds=1), agent="old", reported=False)
    seed(store, now, count=2, agent="kimi", reported=False)
    seed(store, now - timedelta(days=1), agent="kimi", reported=False)
    seed(store, now - timedelta(hours=1), count=3, agent="pi", reported=False)
    seed(store, now, agent=None, reported=False)
    seed(store, now, agent="", reported=False)
    result = store.dashboard_token_metrics(zone=UTC, now=now)
    assert result["available"] is True
    assert result["total"] == result["fresh"] == 28
    assert sum(day["total"] for day in result["daily"]) == 15
    assert result["unreportedRuns"] == [{"agent": "kimi", "runs": 3}, {"agent": "pi", "runs": 3}]
    assert len(result["daily"]) == 14


def test_empty_dashboard_has_zero_counts_and_requested_dates(tmp_path):
    store = make_session_store(tmp_path)
    result = store.dashboard_token_metrics(zone=UTC, now=datetime(2026, 11, 6, 12, tzinfo=UTC))
    assert result["available"] is False
    assert result["total"] == result["fresh"] == result["totalCache"] == 0
    assert result["daily"][0]["date"] == "2026-10-24"
    assert result["daily"][-1]["date"] == "2026-11-06"
    assert len(result["daily"]) == 14
    assert result["unreportedRuns"] == []


@pytest.mark.parametrize("day_window,summary_days", [(0, 1), (14, 0), (7, 8)])
def test_invalid_windows_are_rejected_before_querying(tmp_path, day_window, summary_days):
    store = make_session_store(tmp_path)
    with pytest.raises(ValueError, match="Dashboard windows"):
        store.dashboard_token_metrics(zone=UTC, day_window=day_window, summary_days=summary_days)


def test_custom_window_returns_requested_days_and_summary(tmp_path):
    store = make_session_store(tmp_path)
    now = datetime(2026, 11, 6, 12, tzinfo=UTC)
    seed(store, now - timedelta(days=2), tokens=(1, 0, 0, 0))
    seed(store, now - timedelta(days=1), tokens=(2, 0, 0, 0))
    seed(store, now, tokens=(4, 0, 0, 0))
    result = store.dashboard_token_metrics(zone=UTC, day_window=3, summary_days=2, now=now)
    assert [day["total"] for day in result["daily"]] == [1, 2, 4]
    assert result["total"] == 6


def test_future_only_usage_retains_summary_without_marking_daily_data_available(tmp_path):
    store = make_session_store(tmp_path)
    now = datetime(2026, 11, 6, 12, tzinfo=UTC)
    seed(store, now + timedelta(days=2))
    result = store.dashboard_token_metrics(zone=UTC, now=now)
    assert result["total"] == 20
    assert result["available"] is False
    assert all(day["total"] == 0 for day in result["daily"])
