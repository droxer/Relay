"""The round an answer to an approval wait starts (ADR-023).

A round parked for approval closed its request with the work it had done and
the turn it held back. Its answer does not compile a new round from the
roster: it continues that one — same assignments, same evidence, same spent
budgets — from the held turn (approve) or the turn before it (changes).
"""

from __future__ import annotations

from typing import Any

from ..core.human_waits import QUESTION_ID_PREFIX
from ..core.ids import new_relay_id
from ..security.actor import Actor
from .approvals import PARKED_INDEX_STATE_KEY, ApprovalResumeError, approval_resume
from .errors import CollaborationError
from .intake import _PreparedRound, _round_scope_ids, _round_task_goal
from .models import COLLABORATION_MANIFEST_STATE_KEY
from .request import _round_payload
from .state import ConductorState
from .task_scope import _execution_revision

# Fields a resumed manifest does not inherit: who owned the parked round's
# source, a handoff it carried, and its own round identity.
_UNINHERITED_MANIFEST_FIELDS = ("handoffContext", "sourceOwnership", "humanStarted")


class ApprovalRoundMixin(ConductorState):
    def _approval_round(
        self,
        intent: _PreparedRound,
        actor: Actor,
        fingerprint: str,
        *,
        session: dict[str, Any],
        task: dict[str, Any],
    ) -> dict[str, Any] | None:
        """The run request resuming a parked round, or None when the answered
        wait is not an approval."""
        wait = task.get("waitingRequest") or {}
        if wait.get("kind") != "approval":
            if intent.approve:
                raise CollaborationError(
                    "approval_not_awaited",
                    "This task is not waiting for an approval.",
                )
            return None
        parked = self._parked_round(wait.get("questionId"), session, task)
        try:
            index, carried = approval_resume(parked, approve=intent.approve)
        except ApprovalResumeError as error:
            raise CollaborationError("approval_unavailable", str(error)) from error
        manifest = {
            **{
                key: value
                for key, value in parked["state"][COLLABORATION_MANIFEST_STATE_KEY].items()
                if key not in _UNINHERITED_MANIFEST_FIELDS
            },
            "roundId": new_relay_id("round"),
            "source": "approval",
            "sourceTaskRevision": _execution_revision(task),
            "workScope": {"kind": "task", "taskId": task["id"]},
        }
        team_id, _project_id = _round_scope_ids(intent, session)
        payload = _round_payload(
            intent,
            actor,
            fingerprint,
            task_goal=_round_task_goal(intent, session),
            # The parked round's own assignments: work results are keyed by
            # their ids, so the evidence filed so far still counts.
            resolved=[
                {key: value for key, value in item.items() if key != "resumeRun"}
                for item in parked["assignments"]
            ],
            manifest=manifest,
            required_node_id=parked["nodeId"],
            task_id=task["id"],
            team_id=team_id,
            project_snapshot=manifest.get("projectSnapshot"),
        )
        return {**payload, "_resume": {"index": index, "state": carried}}

    def _parked_round(
        self, question_id: Any, session: dict[str, Any], task: dict[str, Any]
    ) -> dict[str, Any]:
        """The request an approval wait parked, found through the wait's id."""
        prefix = f"{QUESTION_ID_PREFIX}_"
        parked = (
            self.ctx.registry.daemon_store.get_run_request(question_id[len(prefix):])
            if isinstance(question_id, str) and question_id.startswith(prefix)
            else None
        )
        state = (parked or {}).get("state") or {}
        if (
            not parked
            or parked.get("sessionId") != session.get("id")
            or parked.get("taskId") != task["id"]
            or parked.get("status") != "completed"
            or PARKED_INDEX_STATE_KEY not in state
            or not isinstance(state.get(COLLABORATION_MANIFEST_STATE_KEY), dict)
        ):
            raise CollaborationError(
                "approval_unavailable",
                "The round waiting for this approval can no longer be resumed.",
            )
        return parked
