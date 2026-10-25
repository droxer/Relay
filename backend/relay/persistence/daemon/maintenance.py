"""Pruning terminal commands, runs, run requests, and events past retention.

A mixin of ``DatabaseDaemonStore``; it shares the store's engine and tables
(declared on ``DaemonStoreState``) and is not used on its own.
"""

from __future__ import annotations

from datetime import timedelta
from sqlalchemy import (
    Text,
    cast,
    delete,
    or_,
    select,
)
from ..db_time import require_db_time
from ...core.ids import now_iso
from ...core.human_waits import QUESTION_ID_PREFIX
from ..engine import store_transaction
from ..tables.daemon import ACTIVE_RUN_REQUEST_STATUSES
from ..tables.tasks import tasks
from .rules import PRUNABLE_DAEMON_EVENT_PREFIXES, PRUNABLE_DAEMON_EVENT_TYPES
from ...core.daemon_records import TERMINAL_DAEMON_STATUSES
from .rows import (
    terminal_time_expression,
)
from .state import DaemonStoreState


class DaemonRecordMaintenance(DaemonStoreState):
    def prune_terminal_records(
        self,
        retention_seconds: float,
        per_node_limit: int,
        *,
        run_request_retention_seconds: float | None = None,
    ) -> dict[str, int]:
        """Bound each retention transaction and transfer IDs only.

        Visit at most 100 nodes per pass and remove at most 1000 records from
        each table. Keyset rotation prevents quiet nodes from starving.
        Terminal run requests double as idempotency records for dispatch
        retries, so they get their own, longer window and are skipped when it
        is None. A request referenced by an unanswered approval remains live
        resume state even though its execution segment has completed.
        """
        now = require_db_time(now_iso())
        cutoff = now - timedelta(seconds=max(0.0, retention_seconds))
        counts = {"commands": 0, "runs": 0, "events": 0, "runRequests": 0}
        with store_transaction(self.engine) as conn:
            cursors = getattr(self, "_prune_cursors", {})
            self._prune_cursors = cursors
            for name, table in (("commands", self.commands), ("runs", self.runs)):
                nodes = select(self.nodes.c.id).order_by(self.nodes.c.id).limit(100)
                if cursors.get(name):
                    nodes = nodes.where(self.nodes.c.id > cursors[name])
                node_ids = list(conn.scalars(nodes))
                if not node_ids and cursors.get(name):
                    node_ids = list(conn.scalars(select(self.nodes.c.id).order_by(self.nodes.c.id).limit(100)))
                cursors[name] = None
                budget = 1000
                for node_id in node_ids:
                    cursors[name] = node_id
                    terminal_time = terminal_time_expression(table)
                    base = select(table.c.id).where(table.c.node_id == node_id, table.c.status.in_(TERMINAL_DAEMON_STATUSES))
                    expired = list(conn.scalars(base.where(terminal_time <= cutoff).order_by(terminal_time, table.c.id).limit(budget)))
                    if expired:
                        counts[name] += conn.execute(delete(table).where(table.c.id.in_(expired))).rowcount or 0
                        budget -= len(expired)
                    if not budget:
                        break
                    excess = list(conn.scalars(base.order_by(terminal_time.desc(), table.c.id.desc()).offset(max(0, per_node_limit)).limit(budget)))
                    if excess:
                        counts[name] += conn.execute(delete(table).where(table.c.id.in_(excess))).rowcount or 0
                        budget -= len(excess)
                    if not budget:
                        break
            event_ids = select(self.events.c.id).where(
                or_(*(self.events.c.type.startswith(prefix) for prefix in PRUNABLE_DAEMON_EVENT_PREFIXES),
                    self.events.c.type.in_(PRUNABLE_DAEMON_EVENT_TYPES)),
                self.events.c.timestamp <= cutoff,
            ).order_by(self.events.c.timestamp, self.events.c.id).limit(1000)
            counts["events"] = conn.execute(delete(self.events).where(self.events.c.id.in_(event_ids))).rowcount or 0
            if run_request_retention_seconds is not None:
                request_cutoff = now - timedelta(
                    seconds=max(0.0, run_request_retention_seconds)
                )
                approval_wait = (
                    select(tasks.c.id)
                    .where(
                        tasks.c.id == self.run_requests.c.task_id,
                        tasks.c.status == "waiting_for_human",
                        tasks.c.deleted_at.is_(None),
                        tasks.c.snapshot["waitingRequest"]["kind"].as_string() == "approval",
                        tasks.c.snapshot["waitingRequest"]["questionId"].as_string()
                        == f"{QUESTION_ID_PREFIX}_" + cast(self.run_requests.c.id, Text),
                    )
                    .exists()
                )
                request_ids = list(
                    conn.scalars(
                        select(self.run_requests.c.id)
                        .where(
                            self.run_requests.c.status.not_in(
                                ACTIVE_RUN_REQUEST_STATUSES
                            ),
                            self.run_requests.c.updated_at <= request_cutoff,
                            ~approval_wait,
                        )
                        .order_by(self.run_requests.c.updated_at, self.run_requests.c.id)
                        .limit(1000)
                    )
                )
                if request_ids:
                    counts["runRequests"] = (
                        conn.execute(
                            delete(self.run_requests).where(
                                self.run_requests.c.id.in_(request_ids)
                            )
                        ).rowcount
                        or 0
                    )
        return counts
