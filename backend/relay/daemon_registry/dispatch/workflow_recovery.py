"""Owner retry/cancel adapters; an active reservation is never retry authority."""
from __future__ import annotations

from typing import Any

from ...persistence.events import relay_event
from ...persistence.resource_lock import resource_transaction
from ..state import RegistryState
from .workflow_tasks import assert_workflow_task_owner, sync_workflow_task
from .workflow_admission import workflow_request_id, workflow_node_ids, workflow_request_state


class WorkflowRecoveryMixin(RegistryState):
    def decide_workflow_recovery(self, sid: str, decision: dict[str, Any]) -> dict[str, Any]:
        with self.dispatch_lock, self.dispatch_scope(workflow_node_ids(self.store.get_session(sid))), resource_transaction(
            self.daemon_store.engine, f"workflow-gate:{sid}",
        ), self.store.mutation_scope(sid):
            session = self.store.get_session(sid)
            if not session.get("workflowRuns"):
                raise ValueError("workflow_run_missing")
            run = session["workflowRuns"][0]
            request = self.daemon_store.get_run_request(workflow_request_id(run))
            if not request or request["sessionId"] != sid or request["assignments"] != run["assignments"]:
                raise ValueError("workflow_request_mismatch")
            if decision["kind"] in ("retry", "answer"):
                assert_workflow_task_owner(self, request, session)
                # Prepared means either never delivered, or the terminal/reconcile
                # adapter atomically settled the command and cleared the cursor.
                if request["status"] != "prepared" or request.get("currentCommandId") or any(
                    item.get("status") == "running" for item in session.get("agentRuns", [])
                ) or self.daemon_store.list_active_runs(session_ids={sid}):
                    raise ValueError("workflow_exit_evidence_required")
                session = self.store.append_event(sid, relay_event("workflow.recovery_decided", sid, decision))
                run = session["workflowRuns"][0]
                self.daemon_store.update_run_request(request["id"], {
                    "assignments": run["assignments"],
                    "state": workflow_request_state(run, request),
                })
                if run["status"] == "ready":
                    return self.admit_workflow_first_step(sid)
                sync_workflow_task(self, request, session)
                return session
            session = self.store.append_event(sid, relay_event("workflow.recovery_decided", sid, decision))
            reason = "Workflow cancelled by owner."
            if not self.cancel_run_request_before_delivery(request["id"], reason):
                self.cancel_active_run(request["nodeId"], sid, reason, actor_user_id=decision["actorUserId"])
            session = self.store.append_event(sid, relay_event("session.status", sid, {
                "status": "cancelled", "phase": "cancelled", "actorUserId": decision["actorUserId"],
            }))
            sync_workflow_task(self, request, session)
            return session
