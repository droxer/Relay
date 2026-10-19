"""The engine, tables, and lock every ``DatabaseSkillStore`` mixin shares."""

from __future__ import annotations

from typing import TYPE_CHECKING, Any

from sqlalchemy.exc import IntegrityError

from .objects import SkillObjectStore
from .rules import SkillValidationError


class _SkillWriteConflict(RuntimeError):
    pass


class SkillStoreState:
    metadata: Any
    users: Any
    skills: Any
    revisions: Any
    blobs: Any
    files: Any
    events_table: Any
    assignments: Any
    engine: Any
    object_store: SkillObjectStore
    _write_lock: Any

    if TYPE_CHECKING:
        # Methods one mixin calls on another, declared so each type-checks alone.
        def _append_event(
            self,
            conn: Any,
            skill_id: str,
            sequence: int,
            event_type: str,
            payload: dict[str, Any],
        ) -> None:
            ...

        def _record_assignment_event(
            self,
            conn: Any,
            skill_row: Any,
            event_type: str,
            payload: dict[str, Any],
        ) -> None:
            ...

        def _replay(self, conn: Any, skill_id: str) -> dict[str, Any]:
            ...

        @staticmethod
        def _integrity_error(error: IntegrityError) -> SkillValidationError:
            ...
