"""Calendar buckets for dashboard reporting, with compact long-history series."""

from datetime import UTC, date, datetime, timedelta, tzinfo
from typing import Literal

BucketSize = Literal["day", "month", "year"]


def range_utc_bounds(date_range: tuple[date, date], zone: tzinfo) -> tuple[datetime, datetime]:
    """Return inclusive-start, exclusive-end UTC bounds for local calendar dates."""
    start_day, end_day = date_range
    start_at = datetime.combine(start_day, datetime.min.time(), tzinfo=zone).astimezone(UTC)
    end_at = datetime.combine(end_day + timedelta(days=1), datetime.min.time(), tzinfo=zone).astimezone(UTC)
    return start_at, end_at


def reporting_dates(start: date, end: date, *, compact: bool = False) -> tuple[list[date], BucketSize]:
    """Return bucket starts followed by the exclusive final boundary."""
    span = (end - start).days + 1
    if not compact or span <= 90:
        return [start + timedelta(days=index) for index in range(span + 1)], "day"
    if end.year - start.year < 10:
        first = start.year * 12 + start.month - 1
        last = end.year * 12 + end.month - 1
        return [date(index // 12, index % 12 + 1, 1) for index in range(first, last + 2)], "month"
    return [date(year, 1, 1) for year in range(start.year, end.year + 2)], "year"
