"""Freeze a first workflow attempt and its durable, initially prepared request.

No command or execution reservation is allocated here. The dedicated admission
adapter alone can deliver its first step after live checks and any owner gate.
"""
from __future__ import annotations

from typing import Any

from ...collaboration.workflow_compilation import workflow_work_graph
from ...collaboration.workflow_events import current_workflow_run
from ...persistence.events import relay_event
from ...persistence.resource_lock import resource_transaction
from ..state import RegistryState
from .workflow_admission import workflow_request_id, workflow_binding


_THREAD_SCOPE_KEYS = (
    "ownerUserId", "teamId", "projectId", "computerId", "workspaceLayout", "workspaceSubpath",
)


class WorkflowGateStagingMixin(RegistryState):
    def reusable_workflow_thread(
        self, task: dict[str, Any], payload: dict[str, Any], run_id: str,
    ) -> str | None:
        """The Task's newest workflow thread, when its next run may continue there.

        Only the newest is considered: continuing an older one would skip the
        newest run's conversation. It must still belong to the same owner, Team,
        Project, and Computer, be neither deleted nor archived, and hold no run
        still in flight — a blocked run is recovered in place, never restarted.
        A thread that already holds ``run_id`` is a replay of this very start.
        """
        for session_id in reversed(task.get("linkedSessionIds") or []):
            try:
                session = self.store.get_session_header(session_id)
            except (KeyError, FileNotFoundError):
                continue
            runs = session.get("workflowRuns") or []
            if not runs:
                continue
            if any(run.get("workflowRunId") == run_id for run in runs):
                return session_id
            if session.get("deletionRequestedAt") or session.get("archived"):
                return None
            if any(session.get(key) != payload.get(key) for key in _THREAD_SCOPE_KEYS):
                return None
            if any(run.get("status") not in ("completed", "cancelled") for run in runs):
                return None
            if self.daemon_store.active_run_request_for_session_any_node(session_id):
                return None
            return session_id
        return None

    def stage_workflow_gate(
        self, payload: dict[str, Any], assignments: list[dict[str, Any]],
        *, task: dict[str, Any] | None = None, continue_thread: bool = False,
    ) -> dict[str, Any]:
        """Create one durable first-step request, or replay the same start.

        The application derives ``payload.id`` from owner/Team/request identity.
        A transactional resource lock covers the absent-row case across replicas;
        the session row lock alone cannot serialize two initial creations.

        With ``continue_thread`` and a ``task``, the new run joins the Task's
        newest workflow thread when that still fits (reopening it if finished)
        instead of opening ``payload.id``, so the Task keeps one conversation.
        The run id still comes from the dispatch claim, so a replayed start
        finds its own run and appends nothing.
        """
        if not assignments:
            raise ValueError("workflow_assignments_required")
        workflow_work_graph(assignments, team_snapshot=assignments[0]["teamSnapshot"])
        engine = self.daemon_store.engine
        if getattr(self.store, "engine", None) is not engine:
            raise ValueError("workflow_shared_transaction_required")
        run_id = assignments[0]["workflowRunId"]
        reused = self.reusable_workflow_thread(task, payload, run_id) if continue_thread and task else None
        continue_thread = reused is not None
        if reused:
            payload = {**payload, "id": reused}
        session_id = payload["id"]
        with resource_transaction(engine, f"workflow-gate:{session_id}"):
            try:
                existing = self.store.get_session_header(session_id)
            except KeyError:
                existing = None
            if existing is not None:
                if any(existing.get(key) != payload.get(key) for key in (
                    "ownerUserId", "teamId", "projectId", "computerId",
                    "workspaceLayout", "workspaceSubpath",
                )):
                    raise ValueError("workflow_request_conflict")
                runs = existing.get("workflowRuns") or []
                if any(run["workflowRunId"] == run_id for run in runs):
                    if not continue_thread and (
                        len(runs) != 1 or existing.get("taskGoal") != payload.get("taskGoal")
                    ):
                        raise ValueError("workflow_request_conflict")
                    # A replay returns the original snapshot even after a Team edit
                    # or an owner decision. It never resets a gate or appends twice.
                    return existing
                if not continue_thread or not runs:
                    raise ValueError("workflow_request_conflict")
                if existing.get("deletionRequestedAt") or existing.get("archived"):
                    raise ValueError("workflow_session_closed")
                if any(run["status"] not in ("completed", "cancelled") for run in runs):
                    raise ValueError("workflow_run_in_flight")
            if self.daemon_store.active_run_request_for_session_any_node(session_id):
                raise ValueError("workflow_execution_in_flight")
            if existing is None:
                self.store.create_session(payload)
            elif existing.get("status") in ("completed", "failed", "cancelled"):
                self.store.append_event(session_id, relay_event(
                    "session.status", session_id, {"status": "running", "phase": "workflow"},
                ), hydrate_events=False)
            session = self.store.append_event(session_id, relay_event(
                "workflow.started", session_id,
                {"assignments": assignments, "actorUserId": payload["ownerUserId"],
                 **({"taskGoal": payload["taskGoal"]} if existing is not None else {})},
            ), hydrate_events=False)
            run = current_workflow_run(session)
            request = self.daemon_store.create_run_request({
                "id": workflow_request_id(run), "sessionId": session_id,
                "nodeId": assignments[0]["daemonNodeId"], "taskGoal": payload["taskGoal"],
                "assignments": run["assignments"], "status": "prepared", "currentIndex": 0,
                "state": {"_relay_workflow_admission": workflow_binding(run), **({
                    "_relay_task_source_revision": (task.get("executionOwner") or {}).get("revision", 0),
                    "_relay_task_source_status": task["status"],
                } if task else {})},
                **({"taskId": task["id"]} if task else {}),
            })
            if task:
                self.ensure_task_execution_claim(request)
            return session
