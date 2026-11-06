"""Project manager conversation pointer and event-authoritative proposals."""
from __future__ import annotations

from collections.abc import Callable
from contextlib import contextmanager
from collections.abc import Iterator
from typing import Any
from sqlalchemy import insert, select, update
from ...core.ids import new_database_id
from ...core.project_roles import project_with_manager
from ..db_time import parse_db_time
from ..engine import store_transaction
from ..tables.projects import manager_events, manager_proposals
from ..tables.projects import projects
from ..tables.tasks import tasks
from ..resource_lock import resource_transaction
from ..sql import names_no_uuid_row


class ManagerRows:
    # Declared by DatabaseProjectStore.
    engine: Any

    @contextmanager
    def manager_read_scope(self) -> Iterator[None]:
        with store_transaction(self.engine) as conn:
            if self.engine.dialect.name == "postgresql":
                conn.exec_driver_sql("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ")
            yield

    @contextmanager
    def manager_transaction(self, project_id: str, task_ids: list[str] | None = None) -> Iterator[dict[str, Any]]:
        with resource_transaction(self.engine, f"project-manager:{project_id}") as conn:
            project = conn.scalar(select(projects.c.snapshot).where(projects.c.id == project_id).with_for_update())
            if project is None:
                raise KeyError(project_id)
            if task_ids:
                conn.execute(select(tasks.c.id).where(tasks.c.id.in_(task_ids)).order_by(tasks.c.id).with_for_update()).all()
            yield project_with_manager(dict(project))

    def mutate_manager(self, project_id: str, change: Callable[[dict[str, Any]], dict[str, Any] | None]) -> dict[str, Any]:
        return self._mutate_current(project_id, "project.manager_changed", change)  # type: ignore[attr-defined]

    def manager_proposals(self, project_id: str) -> list[dict[str, Any]]:
        with store_transaction(self.engine) as conn:
            return list(conn.execute(select(manager_proposals.c.snapshot).where(
                manager_proposals.c.project_id == project_id,
            ).order_by(manager_proposals.c.created_at.desc(), manager_proposals.c.id.desc()).limit(50)).scalars())

    def manager_proposal(self, project_id: str, proposal_id: str) -> dict[str, Any] | None:
        if names_no_uuid_row(self.engine, proposal_id):
            return None
        with store_transaction(self.engine) as conn:
            value = conn.scalar(select(manager_proposals.c.snapshot).where(
                manager_proposals.c.project_id == project_id, manager_proposals.c.id == proposal_id,
            ).with_for_update())
        return dict(value) if value else None

    def save_manager_proposal(self, proposal: dict[str, Any], *, new: bool = False) -> None:
        with store_transaction(self.engine) as conn:
            if new:
                conn.execute(insert(manager_proposals).values(
                    id=proposal["id"], project_id=proposal["projectId"], state=proposal["state"],
                    snapshot=proposal, created_at=parse_db_time(proposal["createdAt"]),
                ))
            else:
                conn.execute(update(manager_proposals).where(manager_proposals.c.id == proposal["id"]).values(
                    snapshot=proposal, state=proposal["state"],
                ))
            conn.execute(insert(manager_events).values(
                id=new_database_id(), proposal_id=proposal["id"], sequence=proposal["revision"],
                payload={"type": f"proposal.{proposal['state']}", "proposal": proposal},
            ))
