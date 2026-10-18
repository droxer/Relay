"""When a schedule trigger fires.

Schedules are stored as structured presets so the web round-trips them
without parsing cron; this module compiles each to a cron expression and is
the only place Relay evaluates one. Fire times are computed in the
schedule's local wall time and then resolved to UTC, so a time that does not
exist (spring forward) fires at the first valid instant and an ambiguous one
(fall back) fires once.
"""

from __future__ import annotations

from itertools import pairwise

import functools
import os
import re
from datetime import datetime, timedelta, tzinfo, UTC
from typing import Any
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from croniter import CroniterError, croniter

CRON_FLOOR = timedelta(minutes=15)
FLOOR_SAMPLES = 50
EVERY = ("hour", "day", "weekday", "week", "month")
_TIME = re.compile(r"^([01]\d|2[0-3]):([0-5]\d)$")
_DAY_NAMES = {1: "Mon", 2: "Tue", 3: "Wed", 4: "Thu", 5: "Fri", 6: "Sat", 7: "Sun"}
_REPEAT_KEYS = {
    "hour": {"every", "minute"},
    "day": {"every", "at"},
    "weekday": {"every", "at"},
    "week": {"every", "at", "days"},
    "month": {"every", "at", "day"},
}
_FLOOR_ORIGIN = datetime(2026, 1, 1, tzinfo=UTC)


class ScheduleError(ValueError):
    """A schedule the API refuses with a 400; the message names the field."""


@functools.lru_cache(maxsize=1)
def _host_zone() -> tzinfo:
    """The server's zone by IANA name (so DST applies), else a fixed offset."""
    candidates = []
    env_tz = os.environ.get("TZ", "").strip().lstrip(":")
    if env_tz:
        candidates.append(env_tz)
    target = os.path.realpath("/etc/localtime")
    if "zoneinfo/" in target:
        candidates.append(target.split("zoneinfo/", 1)[1])
    for name in candidates:
        try:
            return ZoneInfo(name)
        except (ZoneInfoNotFoundError, ValueError, OSError):
            continue
    return datetime.now().astimezone().tzinfo or UTC


def resolve_timezone(name: str | None) -> tzinfo:
    name = name or os.environ.get("RELAY_TASK_SCHEDULER_TIMEZONE", "").strip() or None
    if name is None:
        return _host_zone()
    return ZoneInfo(name)


def _is_int(value: Any, low: int, high: int) -> bool:
    return isinstance(value, int) and not isinstance(value, bool) and low <= value <= high


def normalize_schedule(raw: Any) -> dict[str, Any]:
    if not isinstance(raw, dict) or set(raw) - {"timezone", "repeat"}:
        raise ScheduleError("schedule must be an object with timezone and repeat (unknown keys refused).")
    zone = raw.get("timezone")
    if zone is not None:
        if not isinstance(zone, str):
            raise ScheduleError("schedule.timezone must be an IANA name or null.")
        try:
            ZoneInfo(zone)
        except (ZoneInfoNotFoundError, ValueError) as error:
            raise ScheduleError(f"schedule.timezone {zone!r} is not a known IANA timezone.") from error
    schedule: dict[str, Any] = {"timezone": zone, "repeat": _normalize_repeat(raw.get("repeat"))}
    if "cron" in schedule["repeat"]:
        _check_floor(schedule)
    return schedule


def _normalize_repeat(repeat: Any) -> dict[str, Any]:
    if not isinstance(repeat, dict):
        raise ScheduleError("schedule.repeat must be an object.")
    if "cron" in repeat:
        if set(repeat) != {"cron"} or not isinstance(repeat["cron"], str):
            raise ScheduleError("schedule.repeat.cron must be a string and the only key (unknown keys refused).")
        expression = " ".join(repeat["cron"].split())
        if len(expression.split(" ")) != 5 or not croniter.is_valid(expression):
            raise ScheduleError("schedule.repeat.cron must be a valid 5-field cron expression.")
        return {"cron": expression}
    if "once" in repeat:
        if set(repeat) != {"once"}:
            raise ScheduleError("schedule.repeat.once takes no other keys (unknown keys refused).")
        try:
            moment = datetime.strptime(str(repeat["once"]), "%Y-%m-%dT%H:%M")
        except ValueError as error:
            raise ScheduleError("schedule.repeat.once must be YYYY-MM-DDTHH:MM.") from error
        return {"once": moment.strftime("%Y-%m-%dT%H:%M")}
    every = repeat.get("every")
    if every not in EVERY:
        raise ScheduleError(f"schedule.repeat.every must be one of: {', '.join(EVERY)}.")
    if set(repeat) - _REPEAT_KEYS[every]:
        raise ScheduleError(f"schedule.repeat has unknown keys for every={every}.")
    if every == "hour":
        if not _is_int(repeat.get("minute"), 0, 59):
            raise ScheduleError("schedule.repeat.minute must be 0–59.")
        return {"every": "hour", "minute": repeat["minute"]}
    at = repeat.get("at")
    if not isinstance(at, str) or not _TIME.match(at):
        raise ScheduleError("schedule.repeat.at must be HH:MM (24-hour).")
    out: dict[str, Any] = {"every": every, "at": at}
    if every == "week":
        days = repeat.get("days")
        if not isinstance(days, list) or not days or not all(_is_int(d, 1, 7) for d in days):
            raise ScheduleError("schedule.repeat.days must be a non-empty list of ISO weekdays 1–7.")
        out["days"] = sorted(set(days))
    if every == "month":
        if not _is_int(repeat.get("day"), 1, 31):
            raise ScheduleError("schedule.repeat.day must be 1–31.")
        out["day"] = repeat["day"]
    return out


def to_cron(repeat: dict[str, Any]) -> str | None:
    if "cron" in repeat:
        return repeat["cron"]
    if "once" in repeat:
        return None
    if repeat["every"] == "hour":
        return f"{repeat['minute']} * * * *"
    hour, minute = (int(part) for part in repeat["at"].split(":"))
    if repeat["every"] == "day":
        return f"{minute} {hour} * * *"
    if repeat["every"] == "weekday":
        return f"{minute} {hour} * * 1-5"
    if repeat["every"] == "week":
        return f"{minute} {hour} * * " + ",".join(str(day % 7) for day in repeat["days"])
    return f"{minute} {hour} {repeat['day']} * *"


def _resolve(local: datetime, zone: tzinfo) -> datetime:
    """Local wall time → UTC. fold=0 takes the first of an ambiguous pair; a
    nonexistent time keeps the pre-transition offset, which lands on the
    first valid instant after the gap."""
    return local.replace(tzinfo=zone, fold=0).astimezone(UTC)


def next_fire_after(schedule: dict[str, Any], after: datetime) -> datetime | None:
    if after.tzinfo is None:
        raise ValueError("after must be timezone-aware")
    zone = resolve_timezone(schedule.get("timezone"))
    repeat = schedule["repeat"]
    if "once" in repeat:
        moment = _resolve(datetime.strptime(repeat["once"], "%Y-%m-%dT%H:%M"), zone)
        return moment if moment > after else None
    if repeat.get("every") == "month" and repeat["day"] > 28:
        return _next_clamped_month_day(repeat, after, zone)
    try:
        iterator = croniter(to_cron(repeat), after.astimezone(zone).replace(tzinfo=None))
        # Iterating in naive local time can step back across a fall-back hour;
        # skip candidates that are not strictly later in real time.
        for _ in range(FLOOR_SAMPLES):
            candidate = _resolve(iterator.get_next(datetime), zone)
            if candidate > after:
                return candidate
    except CroniterError:
        return None
    return None


def _next_clamped_month_day(repeat: dict[str, Any], after: datetime, zone: tzinfo) -> datetime:
    hour, minute = (int(part) for part in repeat["at"].split(":"))
    local = after.astimezone(zone)
    year, month = local.year, local.month
    for _ in range(3):
        following = datetime(year + (month == 12), 1 if month == 12 else month + 1, 1)
        last_day = (following - timedelta(days=1)).day
        candidate = _resolve(datetime(year, month, min(repeat["day"], last_day), hour, minute), zone)
        if candidate > after:
            return candidate
        year, month = following.year, following.month
    raise AssertionError("a month-day schedule always fires within three months")


def next_fires(schedule: dict[str, Any], after: datetime, count: int) -> list[datetime]:
    fires: list[datetime] = []
    cursor = after
    while len(fires) < count:
        following = next_fire_after(schedule, cursor)
        if following is None:
            break
        fires.append(following)
        cursor = following
    return fires


def _check_floor(schedule: dict[str, Any]) -> None:
    fires = next_fires(schedule, _FLOOR_ORIGIN, FLOOR_SAMPLES)
    if not fires:
        raise ScheduleError("schedule.repeat.cron never fires.")
    if any(later - earlier < CRON_FLOOR for earlier, later in pairwise(fires)):
        raise ScheduleError("schedule.repeat.cron must not fire more often than every 15 minutes.")


def summarize(schedule: dict[str, Any]) -> str:
    repeat = schedule["repeat"]
    if "cron" in repeat:
        text = f"Cron {repeat['cron']}"
    elif "once" in repeat:
        text = f"Once at {repeat['once'].replace('T', ' ')}"
    elif repeat["every"] == "hour":
        text = f"Hourly at :{repeat['minute']:02d}"
    elif repeat["every"] == "day":
        text = f"Daily at {repeat['at']}"
    elif repeat["every"] == "weekday":
        text = f"Weekdays at {repeat['at']}"
    elif repeat["every"] == "week":
        text = f"Every {', '.join(_DAY_NAMES[day] for day in repeat['days'])} at {repeat['at']}"
    else:
        text = f"Monthly on day {repeat['day']} at {repeat['at']}"
    return f"{text} ({schedule.get('timezone') or 'server time'})"
