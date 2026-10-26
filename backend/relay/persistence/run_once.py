"""Retryable one-time jobs with a durable eligibility cutoff.

The cutoff commits before work begins. Work and the completion marker share
one transaction, serialized across replicas; a crashed worker rolls back and
releases its database lock without leaving an abandoned claim behind.
"""

from __future__ import annotations

from collections.abc import Iterator
from contextlib import contextmanager
from typing import Any

from sqlalchemy import select, update

from ..core.ids import now_iso
from .db_time import parse_db_time
from .resource_lock import resource_transaction
from .tables.maintenance import maintenance_cursors


def initialize_run_once(engine: Any, name: str) -> None:
    """Persist the first attempt's cutoff, even if the subsequent work fails.

    Failure here must prevent serving: without a durable cutoff a later boot
    could mistake newly enrolled Computers for pre-existing ones.
    """
    with resource_transaction(engine, f"maintenance:{name}") as conn:
        exists = conn.scalar(select(maintenance_cursors.c.name).where(maintenance_cursors.c.name == name))
        if exists is None:
            cutoff = now_iso()
            conn.execute(
                maintenance_cursors.insert().values(
                    name=name,
                    position={"state": "pending", "cutoff": cutoff},
                    updated_at=parse_db_time(cutoff),
                )
            )


@contextmanager
def run_once(engine: Any, name: str) -> Iterator[str | None]:
    """Yield the cutoff for unfinished work, or None if already completed.

    Store writes on this Engine join the transaction. Exceptions, including
    process interruption, leave the durable pending marker available to retry.
    """
    with resource_transaction(engine, f"maintenance:{name}") as conn:
        row = conn.execute(select(maintenance_cursors).where(maintenance_cursors.c.name == name)).mappings().one()
        position = row["position"]
        if position["state"] == "done":
            yield None
            return
        yield position["cutoff"]
        conn.execute(
            update(maintenance_cursors)
            .where(maintenance_cursors.c.name == name)
            .values(
                position={**position, "state": "done"},
                updated_at=parse_db_time(now_iso()),
            )
        )
