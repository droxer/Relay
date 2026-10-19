"""The state every ``CollaborationConductor`` mixin shares.

The conductor is split by concern into mixins (``roster``, ``assignments``,
``task_scope``, ``request``). They all act on one application context, set by
``CollaborationConductor.__init__``; this class only declares it, plus the
methods one mixin calls on another, so each mixin type-checks alone.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Any

from .intake import _PreparedRound


class ConductorState:
    ctx: Any

    if TYPE_CHECKING:

        def _round_work_scope(
            self,
            intent: _PreparedRound,
            session: dict[str, Any] | None,
            is_recovery: bool,
            answered_task: dict[str, Any] | None,
        ) -> tuple[str | None, dict[str, Any]]:
            ...
