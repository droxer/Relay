"""Narrow Computer observations, separate from configuration and runtime inventory."""
from __future__ import annotations

from datetime import timedelta
from typing import Any

from sqlalchemy import DateTime, case, func, or_, select, update

from ...core.daemon_records import NODE_POLL_DRAINED_AT
from ..db_time import format_db_time, parse_db_time, require_db_time
from ..engine import store_transaction
from .. import sql
from .state import DaemonStoreState


OBSERVATION_FIELDS = {
    'id': 'id', 'node_token_hash': 'nodeTokenHash',
    'credential_version': 'credentialVersion', 'status': 'status',
    'retired_at': 'retiredAt', 'last_error': 'lastError',
    'updated_at': 'updatedAt', 'last_seen_at': 'lastSeenAt',
    'last_poll_at': 'lastPollAt',
}
TIME_FIELDS = {'retired_at', 'updated_at', 'last_seen_at', 'last_poll_at', '_observed_at'}


def observation_from_row(row: Any) -> dict[str, Any]:
    return {
        **{wire: format_db_time(row[column]) if column in TIME_FIELDS else row[column]
           for column, wire in OBSERVATION_FIELDS.items()},
        '_observedAt': format_db_time(row['_observed_at']),
    }


class NodeObservationRows(DaemonStoreState):
    def _observation_clock(self, seconds_ago: float = 0) -> Any:
        if self.engine.dialect.name == 'sqlite':
            return func.strftime('%Y-%m-%d %H:%M:%f', 'now', f'-{seconds_ago} seconds', type_=DateTime())
        return func.date_trunc('milliseconds', func.clock_timestamp()) - timedelta(seconds=seconds_ago)

    def _observation_columns(self) -> list[Any]:
        return [*[self.nodes.c[name] for name in OBSERVATION_FIELDS],
                self._observation_clock().label('_observed_at')]

    def get_node_observation(self, node_id: str) -> dict[str, Any] | None:
        if sql.names_no_uuid_row(self.engine, node_id):
            return None
        with store_transaction(self.engine) as conn:
            row = conn.execute(select(*self._observation_columns())
                               .where(self.nodes.c.id == node_id)).mappings().first()
        return observation_from_row(row) if row else None

    def touch_node_observation(
        self, observed: dict[str, Any], *, interval_seconds: float, polled: bool | None = None,
    ) -> dict[str, Any] | None:
        """CAS an ordinary observation; a skipped update returns fresh control state.

        The database due predicate is shared by all replicas. A recent narrow
        read can avoid attempting an UPDATE at all; it never caches authority
        across requests. Control transitions use the existing synchronous path.
        """
        if interval_seconds < 0 or polled is False:
            raise ValueError('Ordinary observations require a nonnegative interval and no drain transition.')
        clock = parse_db_time(observed.get('_observedAt'))
        if clock is not None:
            cutoff_time = clock - timedelta(seconds=interval_seconds)
            seen = parse_db_time(observed.get('lastSeenAt'))
            poll = parse_db_time(observed.get('lastPollAt'))
            if (seen is not None and seen > cutoff_time
                    and (not polled or observed.get('lastPollAt') == NODE_POLL_DRAINED_AT
                         or (poll is not None and poll > cutoff_time))):
                return observed
        nodes = self.nodes.c
        now = self._observation_clock()
        cutoff = self._observation_clock(interval_seconds)
        seen_due = or_(nodes.last_seen_at.is_(None), nodes.last_seen_at <= cutoff)
        poll_due = (or_(nodes.last_poll_at.is_(None), nodes.last_poll_at <= cutoff)
                    & nodes.last_poll_at.is_distinct_from(require_db_time(NODE_POLL_DRAINED_AT)))
        values = {'updated_at': now, 'last_seen_at': case((seen_due, now), else_=nodes.last_seen_at)}
        if polled:
            values['last_poll_at'] = case((poll_due, now), else_=nodes.last_poll_at)
        with store_transaction(self.engine) as conn:
            row = conn.execute(
                update(self.nodes).where(
                    nodes.id == observed['id'],
                    nodes.node_token_hash.is_not_distinct_from(observed.get('nodeTokenHash')),
                    nodes.credential_version == observed.get('credentialVersion', 1),
                    nodes.status == observed['status'],
                    nodes.status != 'deleted', nodes.retired_at.is_(None),
                    (nodes.last_poll_at == require_db_time(NODE_POLL_DRAINED_AT)
                     if observed.get('lastPollAt') == NODE_POLL_DRAINED_AT
                     else nodes.last_poll_at.is_distinct_from(require_db_time(NODE_POLL_DRAINED_AT))),
                    (seen_due | poll_due) if polled else seen_due,
                ).values(**values).returning(*self._observation_columns())
            ).mappings().first()
        # No row can mean a newer replica observation OR changed control state.
        # Never infer authorization failure or success from rowcount alone.
        return observation_from_row(row) if row else self.get_node_observation(observed['id'])
