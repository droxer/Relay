"""Calendar buckets for dashboard reporting, with compact long-history series."""

from datetime import date, timedelta
from typing import Literal

BucketSize = Literal["day", "month", "year"]


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
