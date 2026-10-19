"""The skill event log: append, replay, and read a skill's history."""

from __future__ import annotations

from typing import Any

from sqlalchemy import insert, select, update

from ...core.ids import new_database_id, now_iso
from ..db_time import format_db_time, parse_db_time
from ..engine import store_transaction
from .state import SkillStoreState, _SkillWriteConflict


class SkillEventRows(SkillStoreState):
    def events(self, skill_id: str) -> list[dict[str, Any]]:
        with store_transaction(self.engine) as conn:
            rows = (
                conn.execute(
                    select(self.events_table)
                    .where(self.events_table.c.skill_id == skill_id)
                    .order_by(self.events_table.c.sequence)
                )
                .mappings()
                .all()
            )
        if not rows:
            raise KeyError(skill_id)
        return [
            {
                "id": str(row["id"]),
                "skillId": skill_id,
                "type": row["type"],
                "timestamp": format_db_time(row["timestamp"]),
                **row["payload"],
            }
            for row in rows
        ]

    def _append_event(
        self,
        conn: Any,
        skill_id: str,
        sequence: int,
        event_type: str,
        payload: dict[str, Any],
    ) -> None:
        conn.execute(
            insert(self.events_table).values(
                id=new_database_id(),
                skill_id=skill_id,
                sequence=sequence,
                type=event_type,
                timestamp=parse_db_time(now_iso()),
                payload=payload,
            )
        )

    def _record_assignment_event(
        self,
        conn: Any,
        skill_row: Any,
        event_type: str,
        payload: dict[str, Any],
    ) -> None:
        sequence = int(skill_row["event_version"])
        claimed = conn.execute(
            update(self.skills)
            .where(
                self.skills.c.id == skill_row["id"],
                self.skills.c.event_version == sequence,
            )
            .values(event_version=sequence + 1)
        )
        if claimed.rowcount != 1:
            raise _SkillWriteConflict(str(skill_row["id"]))
        self._append_event(conn, skill_row["id"], sequence, event_type, payload)

    def _replay(self, conn: Any, skill_id: str) -> dict[str, Any]:
        rows = (
            conn.execute(
                select(self.events_table.c.type, self.events_table.c.payload)
                .where(self.events_table.c.skill_id == skill_id)
                .order_by(self.events_table.c.sequence)
            )
            .mappings()
            .all()
        )
        skill: dict[str, Any] | None = None
        for row in rows:
            payload = row["payload"]
            if row["type"] == "skill.created":
                skill = dict(payload["skill"])
            elif row["type"] == "skill.revision.added" and skill is not None:
                skill.update(
                    currentRevisionId=payload["currentRevisionId"],
                    updatedAt=payload.get(
                        "updatedAt", payload["revision"]["createdAt"]
                    ),
                )
                if payload.get("description") is not None:
                    skill["description"] = payload["description"]
                if not skill.get("stableRevisionId"):
                    skill["stableRevisionId"] = payload.get(
                        "stableRevisionId", payload["currentRevisionId"]
                    )
            elif row["type"] == "skill.revision.promoted" and skill is not None:
                skill.update(
                    stableRevisionId=payload["stableRevisionId"],
                    updatedAt=payload["updatedAt"],
                )
            elif row["type"] == "skill.updated" and skill is not None:
                skill.update(payload["patch"])
                skill["updatedAt"] = payload["updatedAt"]
            elif row["type"] == "skill.deleted" and skill is not None:
                skill.update(
                    updatedAt=payload["updatedAt"], deletedAt=payload["deletedAt"]
                )
        if skill is None:
            raise RuntimeError(f"Skill {skill_id} has no creation event")
        return skill
