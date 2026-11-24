"""Workflow terminal projection: durable evidence, no legacy repair policy."""
from __future__ import annotations

from contextlib import ExitStack
from typing import Any

from ...collaboration.workflow_events import current_workflow_run
from ...persistence.events import relay_event
from ...persistence.engine import store_transaction
from ...persistence.resource_lock import resource_transaction
from ..dispatch.workflow_admission import workflow_binding, workflow_request_id, workflow_node_ids, workflow_request_state
from ..records import TERMINAL_CLAIM_ID_STATE_KEY
from ..dispatch.workflow_tasks import sync_workflow_task
from ..state import RegistryState
from .run_cursor import CLEARED_RUN_CURSOR


class WorkflowProgressionMixin(RegistryState):
    def _finalize_workflow_step(self, request: dict[str, Any], event: dict[str, Any], claim: str) -> None:
        sid = request["sessionId"]
        with self.dispatch_scope(workflow_node_ids(self.store.get_session_header(sid))), resource_transaction(self.daemon_store.engine, f"workflow-gate:{sid}"), self.store.mutation_scope(sid):
            request = self.daemon_store.update_run_request_if_claimed(
                request["id"], TERMINAL_CLAIM_ID_STATE_KEY, claim, {},
            )
            if not request:
                return
            session = self.store.get_session_header(sid)
            if session.get("status") in ("cancelled", "failed", "completed") or session.get("deletionRequestedAt"):
                # The caller's terminal-session branch owns these cases.
                raise ValueError("workflow_session_closed")
            run = current_workflow_run(session)
            if request["assignments"] != run["assignments"] or request["currentIndex"] != run["currentIndex"] or (
                request["currentRunId"] != event["runId"] or request["currentCommandId"] != event["commandId"]
                or request["state"].get("_relay_workflow_admission") != workflow_binding(run)
            ):
                raise ValueError("workflow_request_mismatch")
            if request["state"].get("_relay_stop_command_id"):
                event = {**event, "type": "run.cancelled"}
            # A preflight/runtime failure can report exit before run.executing.
            # Matched terminal evidence still needs a recorded attempt to close.
            if not any(item["id"] == event["runId"] for item in session.get("agentRuns", [])):
                command = self.daemon_store.get_command(event["commandId"])
                if not command:
                    raise ValueError("workflow_command_missing")
                self._ensure_agent_started_for_command(request, {**command["command"], "_nodeId": request["nodeId"]})
            self._close_terminal_session_agent(event)
            payload = {**workflow_binding(run), "expectedRevision": run["revision"], "terminalEvent": event}
            payload.pop("revision")
            session = self.store.append_event(sid, relay_event("workflow.step_finished", sid, payload), hydrate_events=False)
            run = current_workflow_run(session)
            owner_stopped = request["state"].get("_relay_stop_actor_user_id") == session.get("ownerUserId")
            status = "cancelled" if owner_stopped else "completed" if run["status"] == "completed" else "prepared"
            if owner_stopped:
                session = self.store.append_event(sid, relay_event("session.status", sid, {
                    "status": "cancelled", "phase": "cancelled", "actorUserId": session["ownerUserId"],
                }), hydrate_events=False)
                run = current_workflow_run(session)
            self.daemon_store.update_run_request_if_claimed(
                request["id"], TERMINAL_CLAIM_ID_STATE_KEY, claim,
                {"status": status, "currentIndex": run["currentIndex"], **CLEARED_RUN_CURSOR,
                 "state": workflow_request_state(run, request)},
            )
            if status == "completed":
                session = self.store.append_event(sid, relay_event("session.completed", sid, {
                    "outcome": "Workflow completed with all required recorded outputs.", "workOutcome": "done",
                }), hydrate_events=False)
            sync_workflow_task(self, request, session)
            self.daemon_store.mark_cancel_commands_completed(request["nodeId"], event["commandId"])
        self.active_commands.pop(event["commandId"], None)
        self.clear_run_output(event["runId"])
        if run["status"] == "ready":
            self._resume_workflow_admission(sid)

    def _resume_workflow_admission(self, sid: str, *, recovery_request_id: str | None = None) -> None:
        """Resume only ledger-authorized work, never repair a failed attempt."""
        try:
            # Report ingestion may already own a transaction. A savepoint is
            # required before catching admission errors, or a partial stage/link
            # could commit with the preceding result after publication failed.
            with self.dispatch_lock, self.dispatch_scope(workflow_node_ids(self.store.get_session_header(sid))), store_transaction(self.daemon_store.engine) as connection, connection.begin_nested():
                self.admit_workflow_first_step(sid)
        except ValueError as error:
            if str(error) == "workflow_computer_unavailable":
                return  # Capacity/liveness wait; no attempt has executed or failed.
            # Failed admission rolled back command publication. Persist the
            # blocker separately: recovery must not silently repair an attempt.
            with resource_transaction(self.daemon_store.engine, f"workflow-gate:{sid}"), ExitStack() as scopes:
                try:
                    scopes.enter_context(self.store.mutation_scope(sid))
                except KeyError:
                    if recovery_request_id is None:
                        raise
                    self._settle_prepared_request_for_missing_session(recovery_request_id)
                    return
                session = self.store.get_session_header(sid)
                run = current_workflow_run(session)
                request = self.daemon_store.get_run_request(workflow_request_id(run))
                if run["status"] != "ready" or session["status"] in ("completed", "failed", "cancelled") or not request or request.get("currentCommandId"):
                    return
                binding = workflow_binding(run)
                session = self.store.append_event(sid, relay_event("workflow.admission_blocked", sid, {
                    **{key: value for key, value in binding.items() if key != "revision"},
                    "expectedRevision": run["revision"], "reason": str(error),
                }), hydrate_events=False)
                self.daemon_store.update_run_request(request["id"], {
                    "state": workflow_request_state(current_workflow_run(session), request),
                })
                sync_workflow_task(self, request, session)
