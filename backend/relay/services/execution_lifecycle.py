"""Execution truth and durable stop-and-delete recovery.

Task/session outcomes are projections, not proof that a remote process exited.
Only terminal command evidence releases a delivered execution reservation.
"""
from __future__ import annotations

import asyncio
from contextlib import nullcontext
from datetime import datetime, timezone
from typing import Any

from loguru import logger

from ..persistence.daemon_store import (
    TERMINAL_CLAIM_EXPIRES_STATE_KEY,
    TERMINAL_CLAIM_ID_STATE_KEY,
)
from ..persistence.store_common import relay_event
from ..persistence.task_execution import request_execution_owner
from ..sessions.controller import SessionController

TERMINAL = {"completed", "failed", "cancelled"}
RECONCILED_ERROR = (
    "Execution reported gone by an operator; the computer never sent exit evidence."
)


def execution_status(session: dict[str, Any], request: dict[str, Any] | None,
                     command: dict[str, Any] | None, *, now: datetime | None = None) -> dict[str, Any]:
    now = now or datetime.now(timezone.utc)
    state = (request or {}).get("state") or {}
    phase, reason = "terminal", None
    confirmed = False
    lease = (command or {}).get("leaseExpiresAt")
    live = False
    if lease:
        try:
            live = datetime.fromisoformat(lease.replace("Z", "+00:00")) > now
        except (ValueError, TypeError):
            pass
    if request:
        if state.get("_relay_recovery_required"):
            phase, reason = "recovery_required", state.get("_relay_recovery_reason") or "finalization_failed"
        elif request.get("status") == "finalizing" or (command or {}).get("status") in TERMINAL:
            phase, reason = "finalizing", "saving_results"
        elif (command or {}).get("status") == "dispatched":
            confirmed = live
            if not live:
                phase, reason = "unresponsive", "execution_unconfirmed"
            elif state.get("_relay_stop_command_id") or session.get("deletionRequestedAt"):
                phase, reason = "stopping", "awaiting_termination"
            else:
                phase, reason = "running", "execution_active"
        else:
            phase, reason = "queued", "awaiting_dispatch"
    elif session.get("hasRunningAgent") or any(
        run.get("status") == "running" for run in session.get("agentRuns", [])
    ):
        # Legacy records without durable ownership need reconciliation, not a
        # guess based on a completed/failed session label.
        if session.get("status") != "cancelled":
            phase, reason = "recovery_required", "orphaned_run"
    if phase == "stopping" and state.get("_relay_stop_requested_at"):
        try:
            stopped_at = datetime.fromisoformat(state["_relay_stop_requested_at"].replace("Z", "+00:00"))
            if (now - stopped_at).total_seconds() >= 60:
                phase, reason = "recovery_required", "termination_unconfirmed"
        except (ValueError, TypeError):
            phase, reason = "recovery_required", "termination_unconfirmed"
    return {
        "phase": phase, "executionConfirmed": confirmed,
        "deletionRequested": bool(session.get("deletionRequestedAt")),
        "canDelete": phase == "terminal", "blockingReason": reason,
        "canRetrySave": phase == "recovery_required" and request is not None
        and request.get("status") == "finalizing" and bool(state.get(TERMINAL_CLAIM_ID_STATE_KEY)),
        "canReportGone": phase == "recovery_required" and reason != "finalization_failed"
        and (request or {}).get("status") != "finalizing"
        and (command or {}).get("status") not in TERMINAL,
        "lastConfirmedAt": (request or {}).get("currentProgressAt"),
        "nextRecoveryAt": state.get("_relay_finalization_retry_at"),
    }


class ExecutionLifecycleService:
    def __init__(self, registry: Any, chat_store: Any, *, interval_seconds: float = 5.0):
        self.registry = registry
        self.chat_store = chat_store
        self.interval_seconds = interval_seconds
        self._task: asyncio.Task | None = None
        self._stop = asyncio.Event()

    def status(self, session: dict[str, Any]) -> dict[str, Any]:
        store = self.registry.daemon_store
        request = store.active_run_request_for_session_any_node(session["id"])
        command = store.get_command(request["currentCommandId"]) if request and request.get("currentCommandId") else None
        if not request:
            # Preserve protection for old commands that predate run requests.
            run = next((r for r in store.list_active_runs() if r.get("sessionId") == session["id"]), None)
            if run:
                command = store.get_command(run["commandId"])
                if command and command.get("status") not in TERMINAL:
                    request = {"status": "running", "state": {}}
        return execution_status(session, request, command)

    def annotate(self, sessions: list[dict[str, Any]]) -> list[dict[str, Any]]:
        store = self.registry.daemon_store
        if not sessions:
            return []
        session_ids = {s["id"] for s in sessions}
        requests = {
            r["sessionId"]: r
            for r in store.list_active_run_requests(session_ids=session_ids)
        }
        legacy = {
            r["sessionId"]: r for r in store.list_active_runs(session_ids=session_ids)
        }
        command_ids = {
            r["currentCommandId"]
            for r in requests.values()
            if r.get("currentCommandId")
        }
        command_ids.update(
            r["commandId"] for r in legacy.values() if r.get("commandId")
        )
        commands = store.get_commands(command_ids)
        result = []
        for session in sessions:
            request = requests.get(session["id"])
            command_id = (request or {}).get("currentCommandId") or (legacy.get(session["id"]) or {}).get("commandId")
            command = commands.get(command_id) if command_id else None
            if not request and command and command.get("status") not in TERMINAL:
                request = {"status": "running", "state": {}}
            result.append({**session, "execution": execution_status(session, request, command)})
        return result

    def admission_scope(self):
        # File-backed command admission uses the same interprocess lock. The
        # database store instead locks the session row during admission/delete.
        return getattr(self.registry.daemon_store, "_run_request_claim_lock", nullcontext)()

    def reconcile(self, session_id: str, employee_id: str) -> dict[str, Any] | None:
        """Record a person's assertion that a blocked execution is really gone.

        Exit evidence only ever arrives from the daemon, so a computer that
        never comes back holds its reservation forever: the thread cannot be
        deleted, and the node cannot be deleted either because the stuck
        request still counts as active work. This is the one path that releases
        a reservation without that evidence. It is therefore confined to an
        execution Relay has already given up on, and the assertion is written
        to the log with its actor so the record never reads as observed exit.

        Returns None when the execution does not qualify; the caller refuses.
        """
        with self.registry.dispatch_lock, self.admission_scope():
            session = self.registry.store.get_session(session_id)
            status = self.status(session)
            if not status["canReportGone"]:
                return None
            request = self.registry.daemon_store.active_run_request_for_session_any_node(session_id)
            session = self.registry.store.append_event(session_id, relay_event(
                "session.execution_reconciled", session_id,
                {"actorEmployeeId": employee_id, "blockingReason": status["blockingReason"]},
            ))
            # The delivered command keeps its own liveness, so closing only the
            # request would leave the legacy active-run fallback reporting the
            # execution as live. Record the same terminal transition the
            # daemon's own run.cancelled would have produced.
            for active in self.registry.daemon_store.list_active_runs(session_ids={session_id}):
                self.registry.daemon_store.mark_command_cancelled(active["nodeId"], {
                    "commandId": active["commandId"], "sessionId": session_id,
                    "runId": active["runId"], "agent": active.get("agent"),
                    "reason": RECONCILED_ERROR,
                })
                self.registry.clear_run_output(active["runId"])
                self.registry.active_commands.pop(active["commandId"], None)
            if request:
                state = dict(request.get("state") or {})
                # Drop the retry/claim bookkeeping too, or finalization keeps
                # waking up for a run nobody is going to report on.
                for key in (TERMINAL_CLAIM_ID_STATE_KEY, TERMINAL_CLAIM_EXPIRES_STATE_KEY,
                            "_relay_recovery_required", "_relay_finalization_retry_at"):
                    state.pop(key, None)
                self.registry.daemon_store.update_run_request(request["id"], {
                    "status": "cancelled", "state": state,
                    "error": RECONCILED_ERROR,
                })
            for run in session.get("agentRuns", []):
                if run.get("status") != "running":
                    continue
                session = self.registry.store.append_event(session_id, relay_event(
                    "agent.completed", session_id, {
                        "runId": run["id"], "agent": run["agent"], "status": "cancelled",
                        "exitCode": 130, "agentLog": run.get("agentLog", ""),
                    },
                ))
            if session.get("status") not in TERMINAL:
                # Same seam deletion uses, so task execution bookkeeping is
                # released exactly once and in one place.
                controller = SessionController(
                    self.registry.store, task_store=self.registry.task_store,
                    task_id=(request or {}).get("taskId") or session.get("taskId"),
                    task_execution_owner=request_execution_owner(request) if request else None,
                )
                session = controller.cancel_session(session_id, RECONCILED_ERROR)
            logger.info("Execution reconciled by assertion", session_id=session_id,
                        employee_id=employee_id, blocking_reason=status["blockingReason"])
            return self.status(session)

    def request_delete(self, session_id: str, employee_id: str) -> dict[str, Any] | None:
        with self.registry.dispatch_lock, self.admission_scope():
            session = self.registry.store.get_session(session_id)
            if not session.get("deletionRequestedAt"):
                session = self.registry.store.append_event(session_id, relay_event(
                    "session.deletion_requested", session_id, {"requestedBy": employee_id},
                ))
            return self.finish_delete(session_id)

    def finish_delete(self, session_id: str) -> dict[str, Any] | None:
        with self.registry.dispatch_lock, self.admission_scope():
            session = self.registry.store.get_session(session_id)
            if not session.get("deletionRequestedAt"):
                return self.status(session)
            request = self.registry.daemon_store.active_run_request_for_session_any_node(session_id)
            controller = SessionController(self.registry.store, task_store=self.registry.task_store,
                                           task_id=(request or {}).get("taskId") or session.get("taskId"),
                                           task_execution_owner=request_execution_owner(request) if request else None)
            if request:
                if request.get("status") != "finalizing":
                    cancelled = self.registry.cancel_run_request_before_delivery(request["id"], "Thread deletion requested.")
                    if not cancelled:
                        self.registry.cancel_active_run(request["nodeId"], session_id, "Thread deletion requested.")
                # Persist the human stop decision too; a racing terminal event
                # may complete bookkeeping but must not start another assignment.
                if session.get("status") not in TERMINAL:
                    session = controller.cancel_session(session_id, "Thread deletion requested.")
            if not request:
                for run in self.registry.daemon_store.list_active_runs():
                    if run.get("sessionId") == session_id:
                        self.registry.cancel_active_run(run["nodeId"], session_id, "Thread deletion requested.")
            # Old finalizers preserved an already-terminal session verbatim,
            # including stale running agent projections. Repair those records
            # from retained daemon exit evidence, never from session status.
            if not self.registry.daemon_store.active_run_request_for_session_any_node(session_id):
                running = {run["id"] for run in session.get("agentRuns", []) if run.get("status") == "running"}
                if running:
                    for event in self.registry.daemon_store.terminal_events_for_session(session_id):
                        if event.get("runId") not in running:
                            continue
                        outcome = "cancelled" if event["type"] == "run.cancelled" else (
                            "completed" if event["type"] == "run.completed" and event.get("exitCode") == 0 else "failed")
                        session = self.registry.store.append_event(session_id, relay_event("agent.completed", session_id, {
                            "runId": event["runId"], "agent": event["agent"], "status": outcome,
                            "exitCode": event.get("exitCode", 130 if outcome == "cancelled" else 1),
                            "agentLog": event.get("agentLog", ""),
                        }))
                        running.remove(event["runId"])
            status = self.status(session)
            if not status["canDelete"]:
                return status
            # Clear external bindings first. Repeating this after a crash is safe.
            self.chat_store.clear_conversation_sessions(session_id)
            controller.delete_session(session_id, snapshot=session,
                                      deleted_by=session.get("deletionRequestedBy"))
            return None

    def tick(self) -> None:
        try:
            self.registry.reap_stale_runs()
        except Exception:
            logger.exception("Execution reconciliation failed; deletion recovery continues")
        pending = self.registry.store.list_pending_deletions(limit=100, offset=getattr(self, "_deletion_offset", 0))
        self._deletion_offset = getattr(self, "_deletion_offset", 0) + len(pending) if len(pending) == 100 else 0
        for session in pending:
            try:
                self.finish_delete(session["id"])
            except KeyError:
                pass  # Another replica completed deletion.
            except Exception:
                logger.exception("Thread deletion recovery failed", session_id=session["id"])

    def start(self) -> None:
        if self._task and not self._task.done():
            return
        self._stop.clear()
        self._task = asyncio.create_task(self._run(), name="relay-execution-recovery")

    async def _run(self) -> None:
        while not self._stop.is_set():
            try:
                await asyncio.to_thread(self.tick)
            except Exception:
                logger.exception("Execution recovery tick failed; retrying")
            try:
                await asyncio.wait_for(self._stop.wait(), self.interval_seconds)
            except TimeoutError:
                pass

    async def stop(self) -> None:
        self._stop.set()
        if self._task:
            await self._task  # Don't abandon a thread still mutating stores.
            self._task = None
