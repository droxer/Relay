"""Copy Automation access in the same transaction that creates its Task."""

from typing import Any

from sqlalchemy import insert, select

from ...core.ids import new_database_id, now_iso
from ..tables.connections import events, grants


def copy_automation_grants(conn: Any, owner: str, routine_id: str, task_id: str) -> None:
    originals = list(conn.scalars(select(grants.c.record).where(grants.c.owner_user_id == owner,
        grants.c.target_type == "automation", grants.c.target_id == routine_id)))
    copied = []
    for original in originals:
        record = {**original, "id": new_database_id(), "revision": 1, "sourceGrantId": original["id"]}
        conn.execute(insert(grants).values(id=record["id"], owner_user_id=owner,
            target_type="task", target_id=task_id, record=record))
        copied.append(record)
    if copied:
        conn.execute(insert(events).values(id=new_database_id(), owner_user_id=owner,
            aggregate_id=f"{owner}:task:{task_id}", sequence=1,
            record={"type": "connection_grants.inherited", "timestamp": now_iso(), "grants": copied}))
