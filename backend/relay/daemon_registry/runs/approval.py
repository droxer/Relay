"""Parking a round at a turn its person approves first (ADR-023).

A mixin of ``DaemonNodeRegistry``: it shares the registry's state and locks
(declared on ``RegistryState``) and is not used on its own.

The round closes the way a blocked round does — the thread completes, its task
waits on its human — so no computer is held while the person decides. The
wait's id derives from the request, so a retried park writes the same wait,
and the answer finds this request through it to resume the work.
"""

from __future__ import annotations

from typing import Any

from ...collaboration.approvals import APPROVAL_OUTCOME, PARKED_INDEX_STATE_KEY
from ...core.human_waits import question_id_for_run, wait_record
from ..state import RegistryState


class ApprovalParkMixin(RegistryState):
    def _park_for_approval(self, run_request: dict[str, Any]) -> None:
        index = run_request.get("currentIndex", 0)
        held = run_request["assignments"][index]
        controller = self._closing_controller(run_request)
        wait = wait_record(
            "approval",
            question_id_for_run(run_request["id"]),
            next_agent_id=held.get("agentId"),
        )
        settle = (
            controller.repair_completion
            if self.store.get_session(run_request["sessionId"]).get("status") == "completed"
            else controller.complete_session
        )
        settle(
            run_request["sessionId"], APPROVAL_OUTCOME,
            task_status="waiting_for_human", work_outcome="blocked",
            input_request=wait,
        )
        self.daemon_store.update_run_request(
            run_request["id"],
            {
                "status": "completed",
                "error": None,
                "state": {**(run_request.get("state") or {}), PARKED_INDEX_STATE_KEY: index},
            },
        )
        self.update_status(run_request["nodeId"], {"status": "ready", "lastError": None})
