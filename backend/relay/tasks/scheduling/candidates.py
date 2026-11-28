"""Bounded Task dispatch scans and their batched admission reads."""

from __future__ import annotations

import asyncio
from collections.abc import Iterator
from enum import Enum
from itertools import batched, islice
from typing import TYPE_CHECKING, Any

from loguru import logger

from ...persistence.task.rows import task_claim_sort_key
from ..flow import flow_scope, is_wip

# Leave time in a tick for Automation and Thread work even if the queue is saturated.
DISPATCH_SCAN_LIMIT = 100


class CandidateOutcome(Enum):
    """What one pass over an assigned task did."""

    IGNORED = "ignored"  # not dispatchable yet; not counted
    SKIPPED = "skipped"  # held back for a recorded reason
    ATTEMPTED = "attempted"  # claimed and handed to a daemon, which refused it
    DISPATCHED = "dispatched"


class DispatchCandidates:
    task_store: Any
    registry: Any
    max_dispatches_per_tick: int
    _dispatch_scan_after: dict[str, Any] | None

    if TYPE_CHECKING:
        def _dispatch_candidate(
            self, loop: asyncio.AbstractEventLoop, candidate: dict[str, Any], *,
            active_task_ids: set[str] | None, full_scopes: set[str] | None,
        ) -> CandidateOutcome: ...

    def _dispatch_assigned_tasks(self, loop: asyncio.AbstractEventLoop) -> tuple[int, int]:
        dispatched = skipped = attempts = 0
        budget = max(DISPATCH_SCAN_LIMIT, self.max_dispatches_per_tick)
        candidates = islice(self._dispatchable_tasks(), budget)
        scanned = 0
        last = None
        for page in batched(candidates, self._dispatch_page_size, strict=False):
            last = dict(page[-1])
            scanned += len(page)
            task_ids = {key for candidate in page if isinstance(key := candidate.get("id"), str)}
            scopes = {scope for candidate in page if not is_wip(candidate) and isinstance(scope := flow_scope(candidate), str)}
            active_reader = getattr(self.registry.daemon_store, "active_run_request_task_ids", None)
            capacity_reader = getattr(self.task_store, "dispatch_capacity_full", None)
            active = active_reader(task_ids) if active_reader else None
            full = capacity_reader(scopes) if capacity_reader else None
            for candidate in page:
                try:
                    outcome = self._dispatch_candidate(loop, candidate, active_task_ids=active, full_scopes=full)
                except Exception:  # noqa: BLE001 - one malformed task must not starve the queue behind it
                    logger.exception("Task dispatch candidate failed", task_id=candidate.get("id"))
                    skipped += 1
                    continue
                if outcome is CandidateOutcome.SKIPPED:
                    skipped += 1
                elif outcome in (CandidateOutcome.ATTEMPTED, CandidateOutcome.DISPATCHED):
                    attempts += 1
                    dispatched += outcome is CandidateOutcome.DISPATCHED
                    if attempts >= self.max_dispatches_per_tick:
                        self._dispatch_scan_after = None
                        return dispatched, skipped
                    if outcome is CandidateOutcome.DISPATCHED and capacity_reader is not None and full is not None:
                        scope = flow_scope(candidate)
                        full.discard(scope)
                        full.update(capacity_reader({scope}))
        self._dispatch_scan_after = last if scanned == budget else None
        return dispatched, skipped

    @property
    def _dispatch_page_size(self) -> int:
        return max(25, min(200, self.max_dispatches_per_tick))

    def _dispatchable_tasks(self) -> Iterator[dict[str, Any]]:
        if hasattr(self.task_store, "list_dispatchable_tasks"):
            after = self._dispatch_scan_after
            page_size = self._dispatch_page_size
            while True:
                page = self.task_store.list_dispatchable_tasks(
                    limit=page_size, after=after
                )
                if not page:
                    return
                # Capture cursor before routing mutates any task in this page.
                after = dict(page[-1])
                yield from page
                if len(page) < page_size:
                    return
        else:
            tasks = [
                task
                for task in self.task_store.list_tasks()
                if task.get("status") in ("assigned", "queued")
                and not task.get("isRoutine")
                and (
                    task.get("assignedAgent")
                    or task.get("assignedTeamId")
                    or task.get("assignedWorkflowId")
                    or task.get("projectId")
                )
            ]
            yield from sorted(tasks, key=task_claim_sort_key)
