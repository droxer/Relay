"""Freeze a first workflow attempt and its durable, initially prepared request.

No command or execution reservation is allocated here. The dedicated admission
adapter alone can deliver its first step after live checks and any owner gate.
"""
from __future__ import annotations

from typing import Any

from ...collaboration.workflow_compilation import workflow_work_graph
from ...persistence.events import relay_event
from ...persistence.resource_lock import resource_transaction
from ..state import RegistryState
from .workflow_admission import workflow_request_id, workflow_binding


class WorkflowGateStagingMixin(RegistryState):
    def stage_workflow_gate(
        self, payload: dict[str, Any], assignments: list[dict[str, Any]],
        *, task: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        """Create one durable first-step request, or replay the same start.

        The application derives ``payload.id`` from owner/Team/request identity.
        A transactional resource lock covers the absent-row case across replicas;
        the session row lock alone cannot serialize two initial creations.
        """
        if not assignments:
            raise ValueError("workflow_assignments_required")
        workflow_work_graph(assignments, team_snapshot=assignments[0]["teamSnapshot"])
        engine = self.daemon_store.engine
        if getattr(self.store, "engine", None) is not engine:
            raise ValueError("workflow_shared_transaction_required")
        session_id = payload["id"]
        with resource_transaction(engine, f"workflow-gate:{session_id}"):
            try:
                existing = self.store.get_session(session_id)
            except KeyError:
                existing = None
            if existing is not None:
                if any(existing.get(key) != payload.get(key) for key in (
                    "ownerUserId", "teamId", "projectId", "computerId", "taskGoal",
                    "workspaceLayout", "workspaceSubpath",
                )):
                    raise ValueError("workflow_request_conflict")
                runs = existing.get("workflowRuns") or []
                if len(runs) != 1 or runs[0]["workflowRunId"] != assignments[0]["workflowRunId"]:
                    raise ValueError("workflow_request_conflict")
                # A replay returns the original snapshot even after a Team edit
                # or an owner decision. It never resets a gate or appends twice.
                return existing
            if self.daemon_store.active_run_request_for_session_any_node(session_id):
                raise ValueError("workflow_execution_in_flight")
            self.store.create_session(payload)
            session = self.store.append_event(session_id, relay_event(
                "workflow.started", session_id,
                {"assignments": assignments, "actorUserId": payload["ownerUserId"]},
            ))
            run = session["workflowRuns"][0]
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
