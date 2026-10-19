"""Skill assignments: which user, team, project, agent, or org gets a skill."""

from __future__ import annotations

from typing import Any

from sqlalchemy import delete, insert, or_, select, update

from ...core.ids import new_database_id, now_iso
from ..db_time import format_db_time
from ..engine import store_transaction
from .rows import _assignment_dict, _assignment_row
from .rules import SkillValidationError
from .state import SkillStoreState


class SkillAssignmentRows(SkillStoreState):
    def upsert_assignment(
        self,
        skill_id: str,
        *,
        target_type: str,
        target_id: str,
        mode: str,
        pin: str | dict[str, str],
        invocation: str,
        created_by_user_id: str,
    ) -> dict[str, Any]:
        if target_type not in {"user", "team", "project", "agent", "org"}:
            raise SkillValidationError("invalid-assignment-target")
        if not isinstance(target_id, str) or not target_id:
            raise SkillValidationError("invalid-assignment-target")
        if mode not in {"optional", "required", "suggested"}:
            raise SkillValidationError("invalid-assignment-mode")
        if invocation not in {"implicit", "explicit"}:
            raise SkillValidationError("invalid-invocation-policy")
        if not (isinstance(pin, str) and pin in {"latest", "stable"}) and not (
            isinstance(pin, dict)
            and set(pin) == {"revisionId"}
            and isinstance(pin["revisionId"], str)
        ):
            raise SkillValidationError("invalid-pin")
        with self._write_lock, store_transaction(self.engine) as conn:
            skill_row = (
                conn.execute(
                    select(self.skills.c.id, self.skills.c.event_version)
                    .where(self.skills.c.id == skill_id)
                    .with_for_update()
                )
                .mappings()
                .first()
            )
            if not skill_row:
                raise KeyError(skill_id)
            existing = (
                conn.execute(
                    select(self.assignments).where(
                        self.assignments.c.skill_id == skill_id,
                        self.assignments.c.target_type == target_type,
                        self.assignments.c.target_id == target_id,
                    )
                )
                .mappings()
                .first()
            )
            timestamp = now_iso()
            assignment_id = str(existing["id"]) if existing else new_database_id()
            created_at = (
                format_db_time(existing["created_at"]) if existing else timestamp
            )
            assignment = {
                "id": assignment_id,
                "skillId": str(skill_id),
                "targetType": target_type,
                "targetId": target_id,
                "mode": mode,
                "pin": pin,
                "invocation": invocation,
                "createdByUserId": created_by_user_id,
                "createdAt": created_at,
                "updatedAt": timestamp,
            }
            values = _assignment_row(assignment)
            if existing:
                conn.execute(
                    update(self.assignments)
                    .where(self.assignments.c.id == existing["id"])
                    .values(**values)
                )
            else:
                conn.execute(insert(self.assignments).values(**values))
            self._record_assignment_event(
                conn,
                skill_row,
                "skill.assignment.upserted",
                {"assignment": assignment},
            )
            return assignment

    def get_assignment(self, assignment_id: str) -> dict[str, Any] | None:
        with store_transaction(self.engine) as conn:
            row = (
                conn.execute(
                    select(self.assignments).where(
                        self.assignments.c.id == assignment_id
                    )
                )
                .mappings()
                .first()
            )
        return _assignment_dict(row) if row else None

    def list_assignments(
        self,
        *,
        skill_id: str | None = None,
        targets: list[tuple[str, str]] | None = None,
    ) -> list[dict[str, Any]]:
        statement = select(self.assignments)
        if skill_id is not None:
            statement = statement.where(self.assignments.c.skill_id == skill_id)
        if targets is not None:
            if not targets:
                return []
            statement = statement.where(
                or_(
                    *(
                        (self.assignments.c.target_type == target_type)
                        & (self.assignments.c.target_id == target_id)
                        for target_type, target_id in targets
                    )
                )
            )
        with store_transaction(self.engine) as conn:
            rows = conn.execute(statement).mappings().all()
        return sorted(
            (_assignment_dict(row) for row in rows),
            key=lambda item: (item["skillId"], item["targetType"], item["targetId"]),
        )

    def delete_assignment(self, assignment_id: str) -> dict[str, Any]:
        with self._write_lock, store_transaction(self.engine) as conn:
            assignment_row = (
                conn.execute(
                    select(self.assignments)
                    .where(self.assignments.c.id == assignment_id)
                    .with_for_update()
                )
                .mappings()
                .first()
            )
            if not assignment_row:
                raise KeyError(assignment_id)
            skill_row = (
                conn.execute(
                    select(self.skills.c.id, self.skills.c.event_version)
                    .where(self.skills.c.id == assignment_row["skill_id"])
                    .with_for_update()
                )
                .mappings()
                .one()
            )
            assignment = _assignment_dict(assignment_row)
            conn.execute(
                delete(self.assignments).where(
                    self.assignments.c.id == assignment_row["id"]
                )
            )
            self._record_assignment_event(
                conn,
                skill_row,
                "skill.assignment.revoked",
                {"assignment": assignment},
            )
            return assignment
