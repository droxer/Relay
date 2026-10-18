from datetime import datetime, UTC

import pytest
from relay.automations.schedule import ScheduleError, next_fire_after, next_fires, normalize_schedule, summarize, to_cron

UTC = UTC


def sched(repeat, tz="UTC"):
    return normalize_schedule({"timezone": tz, "repeat": repeat})


@pytest.mark.parametrize("repeat, cron", [
    ({"every": "hour", "minute": 5}, "5 * * * *"),
    ({"every": "day", "at": "09:30"}, "30 9 * * *"),
    ({"every": "weekday", "at": "08:00"}, "0 8 * * 1-5"),
    ({"every": "week", "at": "07:15", "days": [1, 3, 7]}, "15 7 * * 1,3,0"),
    ({"every": "month", "at": "06:00", "day": 15}, "0 6 15 * *"),
    ({"cron": "*/30 * * * *"}, "*/30 * * * *"),
])
def test_presets_compile(repeat, cron):
    assert to_cron(sched(repeat)["repeat"]) == cron


def test_next_fire_is_strictly_after():
    s = sched({"every": "day", "at": "09:00"})
    assert next_fire_after(s, datetime(2026, 10, 13, 9, 0, tzinfo=UTC)) == datetime(2026, 10, 14, 9, 0, tzinfo=UTC)


def test_timezone_is_applied():
    s = sched({"every": "day", "at": "09:00"}, "Asia/Shanghai")
    assert next_fire_after(s, datetime(2026, 10, 13, 0, 0, tzinfo=UTC)) == datetime(2026, 10, 13, 1, 0, tzinfo=UTC)


def test_spring_forward_nonexistent_time_fires_once_at_first_valid_instant():
    s = sched({"every": "day", "at": "02:30"}, "America/New_York")
    fires = next_fires(s, datetime(2027, 3, 13, 12, 0, tzinfo=UTC), 2)
    # 2027-03-14 02:30 does not exist in New York; resolving with the
    # pre-transition offset (EST, -5) gives 07:30 UTC = 03:30 EDT.
    assert fires == [datetime(2027, 3, 14, 7, 30, tzinfo=UTC), datetime(2027, 3, 15, 6, 30, tzinfo=UTC)]


def test_fall_back_ambiguous_time_fires_once():
    s = sched({"every": "day", "at": "01:30"}, "Europe/London")
    fires = next_fires(s, datetime(2026, 10, 24, 12, 0, tzinfo=UTC), 2)
    # 2026-10-25 01:30 happens twice in London; fold=0 takes the BST one (00:30 UTC).
    assert fires == [datetime(2026, 10, 25, 0, 30, tzinfo=UTC), datetime(2026, 10, 26, 1, 30, tzinfo=UTC)]


def test_month_day_31_clamps_to_month_end():
    s = sched({"every": "month", "at": "00:00", "day": 31})
    assert next_fire_after(s, datetime(2026, 10, 31, 1, tzinfo=UTC)) == datetime(2026, 11, 30, 0, 0, tzinfo=UTC)


def test_once_fires_once():
    s = sched({"once": "2026-10-20T09:00"})
    first = next_fire_after(s, datetime(2026, 10, 13, tzinfo=UTC))
    assert first == datetime(2026, 10, 20, 9, 0, tzinfo=UTC)
    assert next_fire_after(s, first) is None


@pytest.mark.parametrize("raw, message", [
    ({"timezone": "Mars/Base", "repeat": {"every": "day", "at": "09:00"}}, "timezone"),
    ({"timezone": None, "repeat": {"every": "day", "at": "25:00"}}, "repeat.at"),
    ({"timezone": None, "repeat": {"every": "week", "at": "09:00", "days": []}}, "repeat.days"),
    ({"timezone": None, "repeat": {"every": "week", "at": "09:00", "days": [8]}}, "repeat.days"),
    ({"timezone": None, "repeat": {"every": "month", "at": "09:00", "day": 0}}, "repeat.day"),
    ({"timezone": None, "repeat": {"cron": "* * * * *"}}, "15 minutes"),
    ({"timezone": None, "repeat": {"cron": "0,5 * * * *"}}, "15 minutes"),
    ({"timezone": None, "repeat": {"cron": "not a cron"}}, "repeat.cron"),
    ({"timezone": None, "repeat": {"cron": "0 0 30 2 *"}}, "never fires"),
    ({"timezone": None, "repeat": {"once": "tomorrow"}}, "repeat.once"),
    ({"timezone": None, "repeat": {"every": "day", "at": "09:00", "extra": 1}}, "unknown"),
])
def test_invalid_schedules_name_the_field(raw, message):
    with pytest.raises(ScheduleError, match=message):
        normalize_schedule(raw)


def test_summary():
    assert summarize(sched({"every": "weekday", "at": "09:00"}, "Asia/Shanghai")) == "Weekdays at 09:00 (Asia/Shanghai)"
    assert summarize(sched({"every": "week", "at": "09:00", "days": [1, 5]})) == "Every Mon, Fri at 09:00 (UTC)"
    assert summarize(normalize_schedule({"timezone": None, "repeat": {"cron": "0 */2 * * *"}})) == "Cron 0 */2 * * * (server time)"


def test_server_timezone_resolves_by_name_and_follows_dst(monkeypatch):
    from relay.automations import schedule as module

    monkeypatch.delenv("RELAY_TASK_SCHEDULER_TIMEZONE", raising=False)
    monkeypatch.setenv("TZ", "America/New_York")
    module._host_zone.cache_clear()
    try:
        s = normalize_schedule({"timezone": None, "repeat": {"every": "day", "at": "09:00"}})
        fires = next_fires(s, datetime(2026, 10, 31, 12, 0, tzinfo=UTC), 3)
        assert fires == [
            datetime(2026, 10, 31, 13, 0, tzinfo=UTC),  # EDT
            datetime(2026, 11, 1, 14, 0, tzinfo=UTC),  # EST
            datetime(2026, 11, 2, 14, 0, tzinfo=UTC),
        ]
    finally:
        module._host_zone.cache_clear()


def test_invalid_tz_env_falls_back_without_raising(monkeypatch):
    from relay.automations import schedule as module

    monkeypatch.delenv("RELAY_TASK_SCHEDULER_TIMEZONE", raising=False)
    monkeypatch.setenv("TZ", "Not/AZone")
    module._host_zone.cache_clear()
    try:
        assert module.resolve_timezone(None) is not None
    finally:
        module._host_zone.cache_clear()


def test_naive_after_is_refused():
    s = sched({"every": "day", "at": "09:00"})
    with pytest.raises(ValueError, match="timezone-aware"):
        next_fire_after(s, datetime(2026, 10, 13, 9, 0))
