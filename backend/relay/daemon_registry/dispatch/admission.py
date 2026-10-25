"""Admitting a run request: preparation, the task execution claim, activation, and cancellation before or during delivery.

A mixin of ``DaemonNodeRegistry``: it shares the registry's state and locks
(declared on ``RegistryState``) and is not used on its own.
"""

from __future__ import annotations

from typing import Any
from loguru import logger
from ...collaboration.models import (
    COLLABORATION_ADMISSION_EXPIRED_ERROR,
    COLLABORATION_ADMISSION_EXPIRED_OUTCOME,
    COLLABORATION_ADMISSION_EXPIRED_STATE_KEY,
    COLLABORATION_MANIFEST_STATE_KEY,
    COLLABORATION_NEW_SESSION_STATE_KEY,
)
from ...collaboration.work import (
    WORK_PROTOCOL,
)
from ...core.ids import new_database_id
from ...core.daemon_capabilities import (
    has_capability,
    DAEMON_CAPABILITY_WORK_RESULTS,
)
from ...sessions.controller import SessionController
from ...persistence.events import relay_task_event
from ..runs.run_cursor import CLEARED_RUN_CURSOR
from ..state import RegistryState


class RunAdmissionMixin(RegistryState):
    def start_run_request(
        self,
        sandbox_id: str,
        session_id: str,
        task_goal: str,
        assignments: list[dict[str, Any]],
        state: dict[str, Any],
        task_id: str | None = None,
        *,
        active_runs: list[dict[str, Any]] | None = None,
        request_id: str | None = None,
    ) -> dict[str, Any]:
        request = self.prepare_run_request(
            sandbox_id,
            session_id,
            task_goal,
            assignments,
            state,
            task_id,
            active_runs=active_runs,
            request_id=request_id,
        )
        return self.activate_run_request(
            request["id"], task_goal=task_goal, active_runs=active_runs
        )

    def prepare_run_request(
        self,
        sandbox_id: str,
        session_id: str,
        task_goal: str,
        assignments: list[dict[str, Any]],
        state: dict[str, Any],
        task_id: str | None = None,
        *,
        active_runs: list[dict[str, Any]] | None = None,
        request_id: str | None = None,
        start_index: int = 0,
    ) -> dict[str, Any]:
        assignments = [
            {
                **assignment,
                "assignmentId": assignment.get("assignmentId") or new_database_id(),
            }
            for assignment in assignments
        ]
        node_ids = [
            sandbox_id,
            *(
                node_id
                for assignment in assignments
                if (node_id := assignment.get("daemonNodeId"))
            ),
        ]
        with self.dispatch_scope(node_ids):
            return self._prepare_run_request_unlocked(
                sandbox_id,
                session_id,
                task_goal,
                assignments,
                state,
                task_id,
                active_runs,
                request_id,
                start_index,
            )

    def _prepare_run_request_unlocked(
        self,
        sandbox_id: str,
        session_id: str,
        task_goal: str,
        assignments: list[dict[str, Any]],
        state: dict[str, Any],
        task_id: str | None,
        active_runs: list[dict[str, Any]] | None,
        request_id: str | None,
        start_index: int = 0,
    ) -> dict[str, Any]:
        """Stage a request at ``start_index``: 0 for a new round, the held
        turn for a round an approval resumes."""
        existing = self.daemon_store.get_run_request(request_id) if request_id else None
        if existing:
            state = {**state, WORK_PROTOCOL: bool((existing.get("state") or {}).get(WORK_PROTOCOL))}
        else:
            state = {**state, WORK_PROTOCOL: bool(
                any(
                    item.get("teamSnapshot") or item.get("mode", "action") == "action"
                    for item in assignments
                )
                and has_capability(self.sandboxes.get(sandbox_id), DAEMON_CAPABILITY_WORK_RESULTS)
            )}
        if task_id and self.task_store:
            task = self.task_store.get_task(task_id)
            manifest = state.get(COLLABORATION_MANIFEST_STATE_KEY) or {}
            state = {
                **state,
                "_relay_task_source_status": task["status"],
                "_relay_task_source_revision": manifest.get(
                    "sourceTaskRevision", (task.get("executionOwner") or {}).get("revision", 0),
                ),
            }
            # An expired prepared operation must keep its original generation,
            # even if a newer owner has since finished and released its slot.
            for key in ("_relay_task_source_revision", "_relay_task_execution_revision", "_relay_task_source_status"):
                if existing is not None and key in (existing.get("state") or {}):
                    state[key] = existing["state"][key]
        if existing and (existing.get("state") or {}).get(
            COLLABORATION_ADMISSION_EXPIRED_STATE_KEY
        ):
            if not (
                existing.get("status") == "failed"
                and existing.get("error") == COLLABORATION_ADMISSION_EXPIRED_ERROR
            ):
                raise ValueError(
                    "Cannot revive a collaboration request that is not the expired failure."
                )
            session = self.store.get_session(existing["sessionId"])
            is_expired_new_session = bool(
                (existing.get("state") or {}).get(COLLABORATION_NEW_SESSION_STATE_KEY)
                and session.get("status") == "failed"
                and session.get("finalOutcome")
                == COLLABORATION_ADMISSION_EXPIRED_OUTCOME
            )
            if session.get("status") in ("completed", "failed", "cancelled") and not (
                is_expired_new_session
            ):
                raise ValueError(
                    "Cannot revive an expired collaboration admission for a terminal session."
                )
            revived = self.daemon_store.update_run_request_if_status(
                existing["id"],
                existing["status"],
                {
                    "nodeId": sandbox_id,
                    "sessionId": session_id,
                    "taskGoal": task_goal,
                    "assignments": assignments,
                    "state": {
                        **state,
                        COLLABORATION_ADMISSION_EXPIRED_STATE_KEY: True,
                    },
                    "status": "prepared",
                    "currentIndex": start_index,
                    **CLEARED_RUN_CURSOR,
                    "error": None,
                    "completedAt": None,
                },
            )
            if revived:
                return revived
            return self.daemon_store.get_run_request(existing["id"]) or existing
        active = self.daemon_store.active_run_request_for_session_any_node(session_id)
        if active and request_id and active.get("id") == request_id:
            return active
        if active:
            raise ValueError(f"Session {session_id} already has an active daemon run.")
        return self.daemon_store.create_run_request(
            {
                **({"id": request_id} if request_id else {}),
                "nodeId": sandbox_id,
                "sessionId": session_id,
                "taskGoal": task_goal,
                "assignments": assignments,
                "state": state,
                "status": "prepared",
                "currentIndex": start_index,
                **({"taskId": task_id} if task_id else {}),
            }
        )

    def ensure_task_execution_claim(self, request: dict[str, Any]) -> dict[str, Any]:

        task_id = request.get("taskId")
        state = request.get("state") or {}
        if not task_id or not self.task_store or "_relay_task_source_revision" not in state:
            return request  # Previously prepared operations retain legacy revision zero.
        try:
            task = self.task_store.append_event(task_id, relay_task_event(
                "task.execution.claimed", task_id,
                {"requestId": request["id"], "expectedRevision": state["_relay_task_source_revision"], **({"expectedStatus": state["_relay_task_source_status"]} if "_relay_task_source_status" in state else {})},
            ))
        except ValueError as error:
            self.daemon_store.update_run_request_if_status(
                request["id"], "prepared", {"status": "failed", "error": str(error)},
            )
            if str(error).startswith("task_wip_limit:") and state.get(COLLABORATION_NEW_SESSION_STATE_KEY):
                # Admission was refused before execution. Close only the newly
                # allocated thread; an existing conversation remains usable.
                SessionController(self.store).fail_session(request["sessionId"], str(error))
            raise
        revision = task["executionOwner"]["revision"]
        if state.get("_relay_task_execution_revision") == revision:
            return request
        updated = self.daemon_store.update_run_request_if_status(
            request["id"], "prepared",
            {"state": {**state, "_relay_task_execution_revision": revision}},
        )
        if not updated:
            raise ValueError("task_ownership_changed: prepared request changed during claim")
        return updated

    def activate_run_request(
        self,
        request_id: str,
        *,
        task_goal: str | None = None,
        active_runs: list[dict[str, Any]] | None = None,
    ) -> dict[str, Any]:
        request = self.daemon_store.get_run_request(request_id)
        if not request:
            raise KeyError(request_id)
        assignments = request.get("assignments") or []
        index = request.get("currentIndex", 0)
        assignment = assignments[index] if index < len(assignments) else None
        if (
            assignment
            and not request.get("currentCommandId")
            and self.logical_assignment_validator
            and assignment.get("agentId")
        ):
            # Validation may consult monitor_nodes(), whose reaper must not see
            # a request after it has transitioned to running but before its
            # first command is linked.
            self.logical_assignment_validator(assignment)
        with self.dispatch_lock, self.dispatch_scope([request["nodeId"]]):
            request = self.daemon_store.get_run_request(request_id)
            if not request:
                raise KeyError(request_id)
            session = self.store.get_session(request["sessionId"])
            if session.get("status") in ("completed", "failed", "cancelled"):
                if request.get("status") == "prepared":
                    self.daemon_store.update_run_request_if_status(
                        request_id,
                        "prepared",
                        {
                            "status": session["status"],
                            "error": (
                                "Prepared collaboration was not activated because "
                                f"the session is {session['status']}."
                            ),
                        },
                    )
                raise ValueError(
                    f"cannot activate collaboration request for {session['status']} session"
                )
            if request.get("status") == "prepared":
                request = self.ensure_task_execution_claim(request)
                activation_state = dict(request.get("state") or {})
                activation_state.pop(COLLABORATION_ADMISSION_EXPIRED_STATE_KEY, None)
                patch: dict[str, Any] = {
                    "status": "running",
                    "state": activation_state,
                }
                if task_goal is not None:
                    patch["taskGoal"] = task_goal
                    patch["state"] = {
                        **activation_state,
                        "task_goal": task_goal,
                    }
                activated = self.daemon_store.update_run_request_if_status(
                    request_id, "prepared", patch
                )
                request = activated or self.daemon_store.get_run_request(request_id)
                if not request:
                    raise KeyError(request_id)
            if request.get("status") not in ("running", "dispatching"):
                raise ValueError(
                    "cannot activate collaboration request in "
                    f"{request.get('status')} state"
                )
            if request.get("currentCommandId"):
                return request
            session = self.store.get_session(request["sessionId"])
            if session.get("status") in ("completed", "failed", "cancelled"):
                raise ValueError(
                    f"cannot activate collaboration request for {session['status']} session"
                )
            return self._enqueue_current_assignment(
                request,
                active_runs=active_runs,
                validate_logical_assignment=False,
            )

    def cancel_active_run(
        self, sandbox_id: str, session_id: str, reason: str,
        *, actor_user_id: str | None = None,
    ) -> dict[str, Any] | None:
        with self.dispatch_lock:
            return self._cancel_active_run_unlocked(
                sandbox_id, session_id, reason, actor_user_id=actor_user_id,
            )

    def cancel_run_request_before_delivery(
        self, request_id: str, reason: str
    ) -> dict[str, Any] | None:
        """Cancel undelivered work without releasing a delivered run's owner.

        Delivered work keeps its reservation until normal daemon terminal-event
        processing. Callers separately enqueue run.cancel for that case.
        """
        request = self.daemon_store.get_run_request(request_id)
        if not request:
            return None
        with self.dispatch_scope([request["nodeId"]]):
            request = self.daemon_store.get_run_request(request_id)
            if not request or request.get("status") not in (
                "prepared",
                "running",
                "dispatching",
            ):
                return None
            state = dict(request.get("state") or {})
            state.pop("_relay_dispatch_claim_id", None)
            state.pop("_relay_dispatch_claim_expires_at", None)
            cancelled = self.daemon_store.update_run_request_if_status(
                request_id,
                request["status"],
                {"status": "cancelled", "error": reason, "state": state},
                require_undelivered=True,
            )
            if not cancelled:
                return None
            command_id = cancelled.get("currentCommandId")
            staged = (
                self.daemon_store.get_command(command_id)
                if command_id
                else self.daemon_store.pending_command_for_run_request(request_id)
            )
            if staged and staged.get("status") == "pending":
                self.daemon_store.discard_staged_command(staged["id"])
            return cancelled

    def _cancel_active_run_unlocked(
        self, sandbox_id: str, session_id: str, reason: str,
        *, actor_user_id: str | None = None,
    ) -> dict[str, Any] | None:
        active = next(
            (
                run
                for run in self.active_commands.values()
                if run["sandboxId"] == sandbox_id and run["sessionId"] == session_id
            ),
            None,
        )
        if not active:
            durable_run = next(
                (
                    run
                    for run in self.daemon_store.list_active_runs(sandbox_id)
                    if run.get("sessionId") == session_id
                ),
                None,
            )
            if durable_run:
                active = {**durable_run, "sandboxId": sandbox_id}
                self.active_commands[active["commandId"]] = active
        if not active:
            logger.warning(
                "No active run to cancel", sandbox_id=sandbox_id, session_id=session_id
            )
            return None
        logger.info(
            "Cancelling active run",
            sandbox_id=sandbox_id,
            session_id=session_id,
            run_id=active["runId"],
            reason=reason,
        )
        cancel_id = new_database_id()
        request = self.daemon_store.run_request_for_command(active["commandId"])
        if request:
            stopping = self.daemon_store.request_run_stop(
                request["id"], active["commandId"], reason,
                actor_user_id=actor_user_id,
            )
            if not stopping:
                return active
            cancel_id = stopping["state"]["_relay_stop_command_id"]
            if self.daemon_store.get_command(cancel_id):
                return active
        self.enqueue(
            sandbox_id,
            {
                "id": cancel_id,
                "type": "run.cancel",
                "commandId": active["commandId"],
                "sessionId": active["sessionId"],
                "runId": active["runId"],
                "agent": active["agent"],
                "reason": reason,
            },
        )
        return active
