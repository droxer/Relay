"""The skill event log: append, replay, and read a skill's history."""

from __future__ import annotations

from collections import defaultdict
from collections.abc import Iterable, Mapping
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
        events = self.events_table
        history = conn.execute(
            self._replay_events().where(events.c.skill_id == skill_id).order_by(events.c.sequence)
        ).mappings()
        return self._reduce_skill(skill_id, history)

    def _read_projection(self, conn: Any, skill_id: str, snapshot: Any) -> dict[str, Any]:
        return self._read_projections(conn, [(skill_id, snapshot)])[skill_id]

    def _read_projections(self, conn: Any, selected: Iterable[Any]) -> dict[str, dict[str, Any]]:
        results, missing = {}, []
        for key, snapshot in selected:
            if (isinstance(snapshot, dict) and snapshot.get("id") == key
                    and {"ownerUserId", "name", "displayName", "visibility", "updatedAt", "deletedAt"} <= snapshot.keys()):
                results[key] = snapshot
            else:
                missing.append(key)
        if missing:
            events = self.events_table
            histories: dict[str, list[Any]] = defaultdict(list)
            for row in conn.execute(
                self._replay_events().where(events.c.skill_id.in_(missing)).order_by(events.c.skill_id, events.c.sequence),
            ).mappings():
                histories[row["skill_id"]].append(row)
            results.update((key, self._reduce_skill(key, histories[key])) for key in missing)
        return results

    def _replay_events(self) -> Any:
        events = self.events_table
        return select(events.c.skill_id, events.c.type, events.c.payload).where(events.c.type.in_((
            "skill.created", "skill.revision.added", "skill.revision.promoted", "skill.updated", "skill.deleted",
        )))

    @staticmethod
    def _reduce_skill(skill_id: str, rows: Iterable[Mapping[str, Any]]) -> dict[str, Any]:
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
