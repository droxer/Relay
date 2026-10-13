"""One tick of automation work: event matching, then the schedule clock."""

from __future__ import annotations

from datetime import date
from typing import TYPE_CHECKING

from loguru import logger

from .clock import ScheduleClock

if TYPE_CHECKING:
    from .matcher import AutomationMatcher


class AutomationService:
    def __init__(self, *, matcher: AutomationMatcher | None, clock: ScheduleClock) -> None:
        self.matcher = matcher
        self.clock = clock

    def tick(self, today: date) -> tuple[int, int, int]:
        """Return (fired, promoted, skipped)."""
        fired = self._fire()
        promoted, skipped = self.clock.run(today)
        return fired, promoted, skipped

    def _fire(self) -> int:
        if self.matcher is None:
            return 0
        try:
            return self.matcher.run()
        except Exception:
            logger.exception("Automation matching failed")
            return 0
