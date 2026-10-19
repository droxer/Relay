"""How many times a task may be re-dispatched because it is not finished yet.

A round is one pass of a task's assignments. When the last round reports it is
unfinished, the task goes back to the queue for another one — bounded, because
an agent that always says "continue" would otherwise run until it exhausted the
account. The cap is resolved from two places: a per-task override when one is
pinned, the org-wide default otherwise, mirroring how personal-computer limits
resolve in `computer_limits`.
"""

from __future__ import annotations

from typing import Any

from ..core.org_policy import DEFAULT_MAX_TASK_ROUNDS

CONTINUE_STATUS = "continue"


def org_max_task_rounds(org_settings_store: Any) -> int:
    if org_settings_store is None:
        return DEFAULT_MAX_TASK_ROUNDS
    settings = org_settings_store.get_settings()
    value = settings.get("maxTaskRounds")
    return int(value) if value is not None else DEFAULT_MAX_TASK_ROUNDS


def effective_max_task_rounds(task: dict[str, Any], org_settings_store: Any) -> int:
    override = task.get("maxRounds")
    if isinstance(override, int) and not isinstance(override, bool) and override >= 1:
        return override
    return org_max_task_rounds(org_settings_store)


def rounds_used(task: dict[str, Any]) -> int:
    value = task.get("roundCount")
    return value if isinstance(value, int) and not isinstance(value, bool) else 0


def awaits_continuation(task: dict[str, Any]) -> bool:
    """True when the task's last round asked for another one."""
    result = task.get("lastRoundResult")
    return isinstance(result, dict) and result.get("status") == CONTINUE_STATUS


def continuation_session_id(task: dict[str, Any]) -> str | None:
    """The thread a continuation round must run in.

    Rounds cannot start a fresh thread: a thread workspace belongs to its
    session, so a new one would begin with none of the previous round's work in
    it. Continuation is only possible when the thread to continue is known.
    """
    session_id = task.get("continuationSessionId")
    return session_id if isinstance(session_id, str) and session_id else None


def continuation_budget_exhausted(
    task: dict[str, Any], org_settings_store: Any
) -> bool:
    return rounds_used(task) >= effective_max_task_rounds(task, org_settings_store)


def budget_exhausted_message(task: dict[str, Any], org_settings_store: Any) -> str:
    limit = effective_max_task_rounds(task, org_settings_store)
    return (
        f"The task used its {limit}-round budget without reporting it was "
        "finished. Review the work and continue it manually if it should go on."
    )
