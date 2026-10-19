"""``ServerDaemonNodeBackend``: routes a run to a node and hands it to the registry.

Application layer: it sits above ``DaemonNodeRegistry`` and nothing in the
registry calls back into it. The run intake is assembled from one mixin per
concern in the ``intake`` subpackage (idempotency, target validation,
ownership, intent); this module owns provisioning, admission, and cancel.
"""

from __future__ import annotations

from typing import Any

from starlette.concurrency import run_in_threadpool

from ..collaboration.models import (
    COLLABORATION_ADMISSION_EXPIRED_OUTCOME,
    COLLABORATION_NEW_SESSION_STATE_KEY,
)
from ..core.ids import new_sandbox_id, now_iso
from ..core.models import AGENT_NAMES, DAEMON_NODE_SUPPORTED_PROTOCOL_VERSIONS
from ..persistence.protocols import AgentPlacementStore, AgentStore
from ..skills.bundle import resolve_bundle
from .credentials import sandbox_node_auth_error, sandbox_ui_auth_error
from .registry import DaemonNodeRegistry
from ..persistence.task.execution import request_execution_owner
from ..persistence.events import relay_task_event
from .intake.idempotency import RunIdempotencyMixin
from .intake.intent import RunIntentMixin
from .intake.ownership import RunOwnershipMixin, assert_session_owned_by_user
from .intake.validation import RunTargetValidationMixin


class ServerDaemonNodeBackend(
    RunIdempotencyMixin,
    RunTargetValidationMixin,
    RunOwnershipMixin,
    RunIntentMixin,
):
    def __init__(
        self,
        registry: DaemonNodeRegistry,
        *,
        agent_store: AgentStore | None = None,
        agent_placement_store: AgentPlacementStore | None = None,
        skill_store: Any | None = None,
        team_store: Any | None = None,
        project_store: Any | None = None,
    ):
        self.registry = registry
        self.agent_store = agent_store
        self.skill_store = skill_store
        self.team_store = team_store
        self.project_store = project_store
        self.agent_placement_store = agent_placement_store
        self.registry.logical_assignment_validator = self._validate_logical_assignment
        self.registry.logical_skill_bundle_resolver = self._resolve_logical_skill_bundle

    def _resolve_logical_skill_bundle(
        self, agent_id: str, project_id: str | None = None
    ) -> tuple[dict[str, Any] | None, list[dict[str, Any]]]:
        if self.agent_store is None or self.skill_store is None:
            return None, []
        agent = self.agent_store.get_agent(agent_id)
        if not agent or agent.get("deletedAt") or not agent.get("enabled", True):
            raise ValueError("logical agent is disabled or missing")
        context = type(
            "SkillBundleContext",
            (),
            {
                "skill_store": self.skill_store,
                "team_store": self.team_store,
                "project_store": self.project_store,
            },
        )()
        return resolve_bundle(context, agent, project_id=project_id)

    def provision(self, payload: dict[str, Any]) -> dict[str, Any]:
        requested_sandbox_id = payload.get("sandboxId")
        existing = (
            self.registry.get(requested_sandbox_id)
            if requested_sandbox_id
            else self.registry.find_by_user(
                payload["userId"], payload.get("workspacePath")
            )
        )
        if existing:
            if payload.get("actorUserId"):
                if (
                    not payload.get("actorIsAdmin")
                    and existing.get("userId") != payload["actorUserId"]
                ):
                    raise PermissionError("Sandbox access denied.")
                return existing
            ui_error = sandbox_ui_auth_error(existing, payload.get("token"))
            if not ui_error:
                return existing
            node_error = sandbox_node_auth_error(existing, payload.get("nodeToken"))
            if not node_error and payload.get("token"):
                user_id = existing.get("userId") or payload["userId"]
                return self.registry.register(
                    {
                        "sandboxId": existing["id"],
                        "userId": user_id,
                        "token": payload.get("nodeToken", ""),
                        "workspacePath": existing.get("workspacePath"),
                        "workspaceId": existing.get("workspaceId"),
                        "protocolVersion": DAEMON_NODE_SUPPORTED_PROTOCOL_VERSIONS[0],
                        "supportedAgents": [
                            agent
                            for agent, status in existing.get("agents", {}).items()
                            if status == "ready"
                        ],
                        "maxConcurrentRuns": existing.get("maxConcurrentRuns"),
                        "status": "busy"
                        if existing["status"] == "running"
                        else existing["status"],
                    },
                    payload["token"],
                )
            raise PermissionError(node_error or ui_error)
        if not payload.get("token"):
            raise PermissionError("Sandbox token is required.")
        if not payload.get("nodeToken"):
            raise PermissionError("Daemon node token is required.")
        sandbox_id = requested_sandbox_id or new_sandbox_id()
        now = now_iso()
        sandbox = {
            "id": sandbox_id,
            "userId": payload["userId"],
            **(
                {"workspacePath": payload["workspacePath"]}
                if payload.get("workspacePath")
                else {}
            ),
            "status": "provisioning",
            "agents": {agent: "unknown" for agent in AGENT_NAMES},
            "maxConcurrentRuns": 1,
            "token": payload["token"],
            "createdAt": now,
            "updatedAt": now,
            "lastError": "Waiting for daemon node registration.",
        }
        self.registry.register(
            {
                "sandboxId": sandbox_id,
                "userId": payload["userId"],
                "token": payload["nodeToken"],
                "workspacePath": payload.get("workspacePath"),
                "protocolVersion": DAEMON_NODE_SUPPORTED_PROTOCOL_VERSIONS[0],
                "supportedAgents": [],
                "status": "stopped",
            },
            payload["token"],
            authorized_node_location="user-device",
        )
        stored = self.registry.get(sandbox_id) or {}
        return {**sandbox, **stored, "token": payload["token"]}

    def get(self, sandbox_id: str) -> dict[str, Any] | None:
        return self.registry.get(sandbox_id)

    def list(self) -> list[dict[str, Any]]:
        return self.registry.list_ready()

    def provision_daemon_node(self, payload: dict[str, Any]) -> dict[str, Any]:
        sandbox, ui_token, node_token = self.registry.provision_pending(
            payload.get("userId"),
            payload.get("workspacePath"),
            payload.get("sandboxMode") or "boxlite",
            payload.get("nodeLocation"),
            payload.get("displayName"),
        )
        return {
            **sandbox,
            **({"token": ui_token, "sandboxToken": ui_token} if ui_token else {}),
            **({"nodeToken": node_token} if node_token else {}),
        }

    async def run(self, sandbox_id: str, request: dict[str, Any]) -> dict[str, Any]:
        return await run_in_threadpool(self._run_sync, sandbox_id, request)

    def _run_sync(self, sandbox_id: str, request: dict[str, Any]) -> dict[str, Any]:
        request = self._normalize_run_request(sandbox_id, request)
        node_ids = [
            sandbox_id,
            *(
                assignment.get("daemonNodeId")
                for assignment in request["assignments"]
                if assignment.get("daemonNodeId")
            ),
        ]
        # Terminal-event finalization holds the global lock while advancing a
        # request. Admission must retain that same global -> node order for its
        # whole node-scoped mutation, or a validation path that consults global
        # registry state can deadlock with finalization.
        self.registry.reap_stale_runs(force=False)
        with self.registry.dispatch_lock, self.registry.dispatch_scope(node_ids):
            run_request_id = self._run_request_id(request)
            idempotent_session = self._idempotent_session(request, run_request_id)
            if idempotent_session:
                return idempotent_session

            active_runs_by_node = self._active_runs_by_node()
            prepared_request = self._prepared_run_request(request, run_request_id)
            if prepared_request:
                request = self._resume_prepared_request(request, prepared_request)
            # Explicit admission scope is frozen in the authoritative manifest.
            # The task ID has already been supplied by the task/conductor path;
            # a caller-provided manifest cannot grant task mutation authority.
            collaboration = request.get("collaboration")
            if isinstance(collaboration, dict) and isinstance(
                collaboration.get("manifest"), dict
            ):
                request = {
                    **request,
                    "collaboration": {
                        **collaboration,
                        "manifest": {
                            **collaboration["manifest"],
                            "workScope": (
                                {"kind": "task", "taskId": request["taskId"]}
                                if request.get("taskId")
                                else {"kind": "thread"}
                            ),
                        },
                    },
                }
            sandbox = self._validate_run_target(sandbox_id, request)
            request = self._task_workspace_request(request, sandbox)
            existing_session = self._existing_session(request)
            self._validate_existing_session_computer(
                existing_session, sandbox_id, request
            )
            self._validate_run_assignments(
                sandbox_id,
                request,
                active_runs_by_node,
            )
            actor_user_id, owner_agent_id, owner_user_id = self._run_owner(
                request, sandbox
            )
            self._validate_existing_session(
                request,
                owner_user_id,
                run_request_id=(prepared_request or {}).get("id") or run_request_id,
            )
            if request.get("_workspaceBinding") and self.registry.task_store:

                task = self.registry.task_store.get_task(request["taskId"])
                if (
                    task.get("workspaceBinding")
                    and task["workspaceBinding"] != request["_workspaceBinding"]
                ):
                    raise ValueError(
                        "workspace_unavailable: this task was bound by another dispatch."
                    )
                if not task.get("workspaceBinding"):
                    self.registry.task_store.append_event(
                        task["id"],
                        relay_task_event(
                            "task.workspace_bound",
                            task["id"],
                            {"binding": request["_workspaceBinding"]},
                        ),
                    )
            controller = self._run_controller(
                sandbox_id,
                sandbox,
                request,
                owner_user_id,
                owner_agent_id,
            )
            session_id = self._run_session_id(
                controller, request, run_request_id=run_request_id
            )
            run_request = prepared_request or self._prepare_run_request(
                sandbox_id,
                session_id,
                request["taskGoal"],
                request,
                active_runs_by_node,
                run_request_id,
            )
            self._validate_idempotency_fingerprint(
                run_request, request.get("idempotencyFingerprint")
            )
            if run_request.get("status") != "prepared":
                return self.registry.store.get_session(run_request["sessionId"])
            request = self._resume_prepared_request(request, run_request)
            session_id = run_request["sessionId"]
            current_session = self.registry.store.get_session(session_id)
            self._validate_source_ownership(run_request, current_session)
            run_request = self.registry.ensure_task_execution_claim(run_request)

            controller.task_execution_owner = request_execution_owner(run_request)
            if (
                (run_request.get("state") or {}).get(
                    COLLABORATION_NEW_SESSION_STATE_KEY
                )
                and current_session.get("status") == "failed"
                and current_session.get("finalOutcome")
                == COLLABORATION_ADMISSION_EXPIRED_OUTCOME
            ):
                controller.reopen_expired_admission(session_id)
            dispatch_task_goal = self._record_run_intent(
                controller,
                session_id,
                existing_session,
                request,
                actor_user_id,
            )
            self.registry.activate_run_request(
                run_request["id"],
                task_goal=dispatch_task_goal,
                active_runs=active_runs_by_node[run_request["nodeId"]],
            )
            return self.registry.store.get_session(session_id)

    def cancel_run(
        self,
        sandbox_id: str,
        session_id: str,
        reason: str,
        actor_user_id: str | None = None,
        *, actor_is_admin: bool = False,
    ) -> dict[str, Any] | None:
        """Cancel the session's active daemon run.

        Returns None when the node had nothing to cancel and the thread is not
        already terminal — the run finished between discovery and cancellation,
        or its run request is parked in a non-running state such as finalizing,
        which never appears in list_active_runs. That is not an error: the
        caller still owns the thread and cancels it directly.
        """
        sandbox = self.registry.get(sandbox_id)
        if not sandbox:
            raise KeyError(f"Sandbox {sandbox_id} has no registered daemon node.")
        if actor_user_id and not actor_is_admin:
            assert_session_owned_by_user(
                self.registry.store, session_id, actor_user_id
            )
        request = self.registry.daemon_store.active_run_request_for_session_any_node(
            session_id
        )
        if request:
            self.registry.cancel_run_request_before_delivery(request["id"], reason)
        active = self.registry.cancel_active_run(
            sandbox_id, session_id, reason, actor_user_id=actor_user_id,
        )
        if not active:
            session = self.registry.store.get_session(session_id)
            if session.get("status") in ("completed", "failed", "cancelled"):
                return session
            return None
        return self.registry.store.get_session(session_id)
