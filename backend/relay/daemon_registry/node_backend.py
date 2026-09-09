from __future__ import annotations

from collections import defaultdict
from typing import Any
from uuid import UUID, uuid5

from starlette.concurrency import run_in_threadpool

from ..collaboration.models import (
    COLLABORATION_ADMISSION_EXPIRED_OUTCOME,
    COLLABORATION_ADMISSION_EXPIRED_STATE_KEY,
    COLLABORATION_FINGERPRINT_STATE_KEY,
    COLLABORATION_MANIFEST_STATE_KEY,
    COLLABORATION_NEW_SESSION_STATE_KEY,
    CollaborationIdempotencyError,
)
from ..core.computer_identity import computer_id
from ..core.ids import new_sandbox_id, now_iso
from ..core.models import AGENT_NAMES, DAEMON_NODE_SUPPORTED_PROTOCOL_VERSIONS
from ..persistence.protocols import AgentPlacementStore, AgentStore, SessionStore
from ..persistence.stores import valid_agent
from ..sessions import SessionController, initial_agent_state
from ..sessions.bridge import latest_user_turn_marker, latest_user_turn_text
from .credentials import sandbox_node_auth_error, sandbox_ui_auth_error
from .registry import DaemonNodeRegistry
from .scheduling import node_accepts_run


class ServerDaemonNodeBackend:
    def __init__(
        self,
        registry: DaemonNodeRegistry,
        *,
        agent_store: AgentStore | None = None,
        employee_agent_store: AgentStore | None = None,
        agent_placement_store: AgentPlacementStore | None = None,
    ):
        if (
            agent_store is not None
            and employee_agent_store is not None
            and agent_store is not employee_agent_store
        ):
            raise ValueError(
                "Pass either agent_store or employee_agent_store, not both."
            )
        agent_store = agent_store or employee_agent_store
        self.registry = registry
        self.agent_store = agent_store
        self.agent_placement_store = agent_placement_store
        self.registry.logical_assignment_validator = self._validate_logical_assignment

    def idempotent_run(
        self,
        idempotency_key: str,
        actor_employee_id: str | None,
        *,
        actor_is_admin: bool = False,
        expected_fingerprint: str | None = None,
    ) -> dict[str, Any] | None:
        with self.registry.dispatch_lock:
            request = self.registry.daemon_store.get_run_request(
                _idempotent_run_request_id(idempotency_key)
            )
            if not request:
                return None
            self._validate_idempotency_fingerprint(request, expected_fingerprint)
            if (request.get("state") or {}).get(
                COLLABORATION_ADMISSION_EXPIRED_STATE_KEY
            ):
                return None
            if request.get("status") == "prepared":
                return None
            session = self.registry.store.get_session(request["sessionId"])
            if actor_employee_id and not actor_is_admin:
                assert_session_owned_by_employee(
                    self.registry.store, session["id"], actor_employee_id
                )
            return self._reconcile_idempotent_participants(
                request, session, actor_employee_id
            )

    def idempotent_session_run(
        self,
        session_id: str,
        actor_employee_id: str | None,
        *,
        actor_is_admin: bool = False,
        expected_fingerprint: str | None = None,
    ) -> dict[str, Any] | None:
        with self.registry.dispatch_lock:
            request = (
                self.registry.daemon_store.active_run_request_for_session_any_node(
                    session_id
                )
            )
            if not request:
                return None
            try:
                self._validate_idempotency_fingerprint(request, expected_fingerprint)
            except CollaborationIdempotencyError:
                return None
            if request.get("status") == "prepared":
                return None
            session = self.registry.store.get_session(request["sessionId"])
            if actor_employee_id and not actor_is_admin:
                assert_session_owned_by_employee(
                    self.registry.store, session["id"], actor_employee_id
                )
            return self._reconcile_idempotent_participants(
                request, session, actor_employee_id
            )

    def _reconcile_idempotent_participants(
        self,
        run_request: dict[str, Any],
        session: dict[str, Any],
        actor_employee_id: str | None,
    ) -> dict[str, Any]:
        """Repair room admission if dispatch committed before that event did."""
        manifest = (run_request.get("state") or {}).get(
            COLLABORATION_MANIFEST_STATE_KEY
        )
        if not isinstance(manifest, dict):
            return session
        agent_ids = [
            assignment["agentId"]
            for assignment in manifest.get("assignments", [])
            if isinstance(assignment, dict)
            and isinstance(assignment.get("agentId"), str)
            and assignment["agentId"]
        ]
        if not agent_ids:
            return session
        return SessionController(self.registry.store).record_participants_joined(
            session["id"], agent_ids, actor_employee_id
        )

    def _validate_logical_assignment(self, assignment: dict[str, Any]) -> None:
        if self.agent_store is None or self.agent_placement_store is None:
            raise ValueError("logical assignments require agent and placement stores")
        agent = self.agent_store.get_agent(assignment.get("agentId"))
        if not agent or agent.get("deletedAt") or not agent.get("enabled", True):
            raise ValueError("logical agent is disabled or missing")
        if any(
            agent.get(field) for field in ("skillPolicy", "toolPolicy", "modelPolicy")
        ):
            raise ValueError(
                "agent_policy_unsupported: logical agent policy is not enforceable by this runtime"
            )
        if agent.get("executorKind") != assignment.get("executorKind"):
            raise ValueError("logical agent executor changed")
        if agent.get("version") != assignment.get("agentVersion"):
            raise ValueError("logical agent version changed")
        placement = self.agent_placement_store.get_placement(
            assignment.get("placementId")
        )
        if not placement or placement.get("desiredState") != "active":
            raise ValueError("placement is not active")
        from ..services.agent_routing import placement_node

        current_node = placement_node(
            placement,
            {node["id"]: node for node in self.registry.monitor_nodes()},
        )
        if (
            placement.get("agentId") != agent.get("id")
            or placement.get("supervisorEmployeeId")
            != agent.get("supervisorEmployeeId")
            or not current_node
            or current_node["id"] != assignment.get("daemonNodeId")
            or placement.get("executorKind") != agent.get("executorKind")
        ):
            raise ValueError("placement no longer matches the selected agent and node")
        if not self.registry.get(assignment.get("daemonNodeId")):
            raise ValueError("daemon node is no longer available")

    def provision(self, payload: dict[str, Any]) -> dict[str, Any]:
        requested_sandbox_id = payload.get("sandboxId")
        existing = (
            self.registry.get(requested_sandbox_id)
            if requested_sandbox_id
            else self.registry.find_by_employee(
                payload["employeeId"], payload.get("workspacePath")
            )
        )
        if existing:
            if payload.get("actorEmployeeId"):
                if (
                    not payload.get("actorIsAdmin")
                    and existing.get("employeeId") != payload["actorEmployeeId"]
                ):
                    raise PermissionError("Sandbox access denied.")
                return existing
            ui_error = sandbox_ui_auth_error(existing, payload.get("token"))
            if not ui_error:
                return existing
            node_error = sandbox_node_auth_error(existing, payload.get("nodeToken"))
            if not node_error and payload.get("token"):
                employee_id = existing.get("employeeId") or payload["employeeId"]
                return self.registry.register(
                    {
                        "sandboxId": existing["id"],
                        "employeeId": employee_id,
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
            "employeeId": payload["employeeId"],
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
                "employeeId": payload["employeeId"],
                "token": payload["nodeToken"],
                "workspacePath": payload.get("workspacePath"),
                "protocolVersion": DAEMON_NODE_SUPPORTED_PROTOCOL_VERSIONS[0],
                "supportedAgents": [],
                "status": "stopped",
            },
            payload["token"],
            authorized_node_location="employee-device",
        )
        stored = self.registry.get(sandbox_id) or {}
        return {**sandbox, **stored, "token": payload["token"]}

    def get(self, sandbox_id: str) -> dict[str, Any] | None:
        return self.registry.get(sandbox_id)

    def list(self) -> list[dict[str, Any]]:
        return self.registry.list_ready()

    def provision_daemon_node(self, payload: dict[str, Any]) -> dict[str, Any]:
        sandbox, ui_token, node_token = self.registry.provision_pending(
            payload.get("employeeId"),
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
        # Global recovery runs before node scopes so run admission follows the
        # same global -> node order as terminal-event finalization.
        self.registry.reap_stale_runs(force=False)
        with self.registry.dispatch_scope(node_ids):
            run_request_id = self._run_request_id(request)
            idempotent_session = self._idempotent_session(request, run_request_id)
            if idempotent_session:
                return idempotent_session

            active_runs_by_node = self._active_runs_by_node()
            prepared_request = self._prepared_run_request(request, run_request_id)
            if prepared_request:
                request = self._resume_prepared_request(request, prepared_request)
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
            actor_employee_id, owner_agent_id, owner_employee_id = self._run_owner(
                request, sandbox
            )
            self._validate_existing_session(
                request,
                owner_employee_id,
                run_request_id=(prepared_request or {}).get("id") or run_request_id,
            )
            if request.get("_workspaceBinding") and self.registry.task_store:
                from ..persistence.store_common import relay_task_event

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
                owner_employee_id,
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
                actor_employee_id,
            )
            self.registry.activate_run_request(
                run_request["id"],
                task_goal=dispatch_task_goal,
                active_runs=active_runs_by_node[run_request["nodeId"]],
            )
            return self.registry.store.get_session(session_id)

    def _task_workspace_request(
        self, request: dict[str, Any], node: dict[str, Any]
    ) -> dict[str, Any]:
        """Enforce affinity at admission, including callers outside task dispatch."""
        from ..services.task_workspace import (
            recorded_task_workspace,
            resolve_task_workspace,
        )

        if not request.get("taskId") or not self.registry.task_store:
            return request
        task = self.registry.task_store.get_task(request["taskId"])
        actor = request.get("actorEmployeeId")
        if (
            actor
            and not request.get("actorIsAdmin")
            and actor
            not in (task.get("ownerEmployeeId"), task.get("assigneeEmployeeId"))
        ):
            raise PermissionError("Task belongs to another employee.")
        binding = recorded_task_workspace(
            task, self.registry.store, self.registry.monitor_nodes()
        )
        # Project identity is supplied only by the authorized project dispatch path.
        project = None
        if request.get("projectId") and request.get("workspaceLayout") == "project":
            project = {"workspaceSubpath": request.get("workspaceSubpath")}
        layout, subpath = resolve_task_workspace(
            {**task, **({"workspaceBinding": binding} if binding else {})},
            node=node,
            project_snapshot=project,
        )
        if binding and layout in ("thread", "node-root"):
            requested_session = request.get("sessionId")
            if requested_session and requested_session != binding.get("sessionId"):
                raise ValueError(
                    "workspace_unavailable: this legacy task must continue in its original thread."
                )
            request = {**request, "sessionId": binding["sessionId"]}
        if request.get("sessionId"):
            existing = self.registry.store.get_session(request["sessionId"])
            if layout in ("task", "project") and (
                existing.get("workspaceLayout") != layout
                or existing.get("workspaceSubpath") != subpath
            ):
                raise ValueError(
                    "workspace_unavailable: linking a thread cannot relocate its files."
                )
        binding = binding or {
            "computerId": computer_id(node),
            "layout": layout,
            "subpath": subpath,
            **(
                {"workspaceRoot": node["workspacePath"]}
                if node.get("workspacePath")
                else {}
            ),
        }
        return {
            **request,
            "workspaceLayout": layout,
            "workspaceSubpath": subpath,
            "_workspaceBinding": binding,
        }

    def _normalize_run_request(
        self, sandbox_id: str, request: dict[str, Any]
    ) -> dict[str, Any]:
        resolved_assignments = []
        for assignment in request["assignments"]:
            resolved = {
                **assignment,
                "executorKind": assignment.get("executorKind")
                or assignment.get("agent"),
            }
            resolved_assignments.append(resolved)
        return {**request, "assignments": resolved_assignments}

    @staticmethod
    def _run_request_id(request: dict[str, Any]) -> str | None:
        idempotency_key = request.get("idempotencyKey")
        if not isinstance(idempotency_key, str) or not idempotency_key:
            return None
        return _idempotent_run_request_id(idempotency_key)

    def _idempotent_session(
        self, request: dict[str, Any], run_request_id: str | None
    ) -> dict[str, Any] | None:
        existing_request = (
            self.registry.daemon_store.get_run_request(run_request_id)
            if run_request_id
            else self.registry.daemon_store.active_run_request_for_session_any_node(
                request.get("sessionId")
            )
            if isinstance(request.get("sessionId"), str)
            else None
        )
        if not existing_request:
            return None
        self._validate_idempotency_fingerprint(
            existing_request, request.get("idempotencyFingerprint")
        )
        if (existing_request.get("state") or {}).get(
            COLLABORATION_ADMISSION_EXPIRED_STATE_KEY
        ):
            return None
        if existing_request.get("status") == "prepared":
            return None
        session = self.registry.store.get_session(existing_request["sessionId"])
        actor_employee_id = request.get("actorEmployeeId")
        if actor_employee_id and request.get("actorIsAdmin") is not True:
            assert_session_owned_by_employee(
                self.registry.store, session["id"], actor_employee_id
            )
        return session

    @staticmethod
    def _validate_idempotency_fingerprint(
        run_request: dict[str, Any], expected_fingerprint: str | None
    ) -> None:
        if not expected_fingerprint:
            return
        actual = (run_request.get("state") or {}).get(
            COLLABORATION_FINGERPRINT_STATE_KEY
        )
        if actual and actual != expected_fingerprint:
            raise CollaborationIdempotencyError(
                "The idempotency key already belongs to a different collaboration intent."
            )

    def _prepared_run_request(
        self, request: dict[str, Any], run_request_id: str | None
    ) -> dict[str, Any] | None:
        if not run_request_id:
            session_id = request.get("sessionId")
            existing = (
                self.registry.daemon_store.active_run_request_for_session_any_node(
                    session_id
                )
                if isinstance(session_id, str) and session_id
                else None
            )
        else:
            existing = self.registry.daemon_store.get_run_request(run_request_id)
        if not existing or existing.get("status") != "prepared":
            return None
        self._validate_idempotency_fingerprint(
            existing, request.get("idempotencyFingerprint")
        )
        return existing

    @staticmethod
    def _resume_prepared_request(
        request: dict[str, Any], prepared: dict[str, Any]
    ) -> dict[str, Any]:
        state = prepared.get("state") or {}
        manifest = state.get(COLLABORATION_MANIFEST_STATE_KEY)
        resumes_new_thread = not request.get("sessionId")
        return {
            **request,
            "assignments": prepared["assignments"],
            "daemonNodeId": prepared["nodeId"],
            "sessionId": prepared["sessionId"],
            "_admissionId": prepared["id"],
            **({"_resumedPreparedNewThread": True} if resumes_new_thread else {}),
            **(
                {"collaboration": {"manifest": manifest}}
                if isinstance(manifest, dict)
                else {}
            ),
        }

    def _active_runs_by_node(self) -> dict[str, list[dict[str, Any]]]:
        active_runs_by_node: dict[str, list[dict[str, Any]]] = defaultdict(list)
        for active_run in self.registry.daemon_store.list_active_runs():
            active_runs_by_node[active_run["nodeId"]].append(active_run)
        return active_runs_by_node

    def _validate_run_target(
        self, sandbox_id: str, request: dict[str, Any]
    ) -> dict[str, Any]:
        sandbox = self.registry.get(sandbox_id)
        if not sandbox:
            raise KeyError(f"Sandbox {sandbox_id} has no registered daemon node.")
        if not sandbox.get("employeeId") and request.get("agentFirst") is not True:
            raise ValueError(
                f"Sandbox {sandbox_id} daemon node is not assigned to an employee."
            )
        assignment_nodes = {
            assignment.get("daemonNodeId") or sandbox_id
            for assignment in request["assignments"]
        }
        if len(assignment_nodes) > 1:
            raise ValueError(
                "workspace_unavailable: collaboration requires every agent to run on the same node."
            )
        if any(self.registry.get(node_id) is None for node_id in assignment_nodes):
            raise ValueError("An assigned runtime node is no longer registered.")
        return sandbox

    def _existing_session(self, request: dict[str, Any]) -> dict[str, Any] | None:
        session_id = request.get("sessionId")
        return self.registry.store.get_session(session_id) if session_id else None

    def _validate_run_assignments(
        self,
        sandbox_id: str,
        request: dict[str, Any],
        active_runs_by_node: dict[str, list[dict[str, Any]]],
    ) -> None:
        for assignment in request["assignments"]:
            node_id = assignment.get("daemonNodeId") or sandbox_id
            node = self.registry.get(node_id)
            assert node is not None
            if assignment.get("agentId"):
                self._validate_logical_assignment(assignment)
            if not self.registry.is_live(node_id):
                raise ValueError(f"Sandbox {node_id} daemon node heartbeat expired.")
            executor_kind = assignment["executorKind"]
            if executor_kind in set(node.get("disabledAgents") or []):
                raise ValueError(
                    f"Sandbox {node_id} daemon node has disabled agent(s): {executor_kind}. "
                    "Re-enable them from the admin console to dispatch work."
                )
            if node.get("agents", {}).get(executor_kind) != "ready":
                raise ValueError(
                    f"Sandbox {node_id} does not have ready agent {executor_kind}."
                )
            if not node_accepts_run(
                node,
                active_runs=active_runs_by_node[node_id],
                session_id=request.get("sessionId"),
            ):
                raise ValueError(
                    f"capacity_exhausted: Sandbox {node_id} has no available execution slot."
                )

    def _validate_existing_session_computer(
        self,
        session: dict[str, Any] | None,
        sandbox_id: str,
        request: dict[str, Any],
    ) -> None:
        if not session:
            return
        nodes = {node["id"]: node for node in self.registry.list_ready()}
        identity = session.get("computerId")
        if not identity and session.get("managedNodeId"):
            identity = f"managed:{session['managedNodeId']}"
        if not identity and self.agent_placement_store is not None:
            from ..services.agent_routing import resolve_legacy_session_computer_id

            identity = resolve_legacy_session_computer_id(
                session,
                self.agent_placement_store,
                nodes,
                self.registry.daemon_store,
            )
        if identity is None:
            recorded = session.get("daemonNodeId")
            if not recorded:
                return
            if recorded in nodes:
                identity = computer_id(nodes[recorded])
            elif recorded == sandbox_id:
                return
            else:
                raise ValueError(
                    "workspace_unavailable: the legacy thread's Computer cannot be recovered."
                )
        assignment_node_ids = {
            assignment.get("daemonNodeId") or sandbox_id
            for assignment in request["assignments"]
        }
        if identity and any(
            node_id not in nodes or computer_id(nodes[node_id]) != identity
            for node_id in assignment_node_ids
        ):
            raise ValueError(
                "workspace_unavailable: selected runtime is not on the thread's Computer."
            )

    def _run_owner(
        self, request: dict[str, Any], sandbox: dict[str, Any]
    ) -> tuple[str | None, str | None, str | None]:
        actor_employee_id = request.get("actorEmployeeId")
        owner_agent_id = next(
            (
                assignment.get("agentId")
                for assignment in request["assignments"]
                if assignment.get("agentId")
            ),
            None,
        )
        owner_employee_id = (
            (self.agent_store.get_agent(owner_agent_id) or {}).get(
                "supervisorEmployeeId"
            )
            if owner_agent_id and self.agent_store
            else actor_employee_id or sandbox.get("employeeId")
        )
        return actor_employee_id, owner_agent_id, owner_employee_id

    def _validate_existing_session(
        self,
        request: dict[str, Any],
        owner_employee_id: str | None,
        *,
        run_request_id: str | None = None,
    ) -> None:
        session_id = request.get("sessionId")
        if not session_id:
            return
        if not owner_employee_id:
            raise PermissionError("Logical agent has no supervisor.")
        assert_session_owned_by_employee(
            self.registry.store, session_id, owner_employee_id
        )
        active = self.registry.daemon_store.active_run_request_for_session_any_node(
            session_id
        )
        if active and active.get("id") != run_request_id:
            raise ValueError(f"Session {session_id} already has an active daemon run.")

    def _run_controller(
        self,
        sandbox_id: str,
        sandbox: dict[str, Any],
        request: dict[str, Any],
        owner_employee_id: str | None,
        owner_agent_id: str | None,
    ) -> SessionController:
        if sandbox["status"] in ("stopped", "failed", "provisioning"):
            raise ValueError(f"Sandbox {sandbox_id} daemon node is not ready.")
        task_id = request.get("taskId")
        if not isinstance(task_id, str) or not task_id:
            task_id = None
        team_id = request.get("teamId")
        if not isinstance(team_id, str) or not team_id:
            team_id = None
        project_id = request.get("projectId")
        if not isinstance(project_id, str) or not project_id:
            project_id = None
        workspace_layout = request.get("workspaceLayout")
        if workspace_layout not in ("thread", "project", "task"):
            workspace_layout = None
        workspace_subpath = request.get("workspaceSubpath")
        if not isinstance(workspace_subpath, str) or not workspace_subpath:
            workspace_subpath = None
        return SessionController(
            self.registry.store,
            task_store=self.registry.task_store,
            task_id=task_id,
            workspace_path=sandbox.get("workspacePath") or "/workspace",
            owner_employee_id=owner_employee_id,
            owner_agent_id=owner_agent_id,
            team_id=team_id,
            project_id=project_id,
            workspace_layout=workspace_layout,
            workspace_subpath=workspace_subpath,
            daemon_node_id=sandbox_id,
            managed_node_id=sandbox.get("managedNodeId"),
            computer_id=computer_id(sandbox),
        )

    @staticmethod
    def _run_session_id(
        controller: SessionController,
        request: dict[str, Any],
        *,
        run_request_id: str | None = None,
    ) -> str:
        existing_session_id = request.get("sessionId")
        if existing_session_id:
            return existing_session_id
        participants = [
            "human",
            *dict.fromkeys(
                assignment["executorKind"] for assignment in request["assignments"]
            ),
        ]
        return controller.create_session(
            request["taskGoal"],
            participants,
            session_id=run_request_id,
        )["id"]

    def _record_run_intent(
        self,
        controller: SessionController,
        session_id: str,
        existing_session: dict[str, Any] | None,
        request: dict[str, Any],
        actor_employee_id: str | None,
    ) -> str:
        collaboration = request.get("collaboration")
        manifest = (
            collaboration.get("manifest")
            if isinstance(collaboration, dict)
            and isinstance(collaboration.get("manifest"), dict)
            else None
        )
        round_id = manifest.get("roundId") if manifest else None
        current_session = self.registry.store.get_session(session_id)
        if round_id and any(
            event.get("type") == "collaboration.round.started"
            and (event.get("manifest") or {}).get("roundId") == round_id
            for event in current_session.get("events", [])
        ):
            return (
                latest_user_turn_text(current_session)
                if request.get("decision")
                else request["taskGoal"]
            )
        decision = (
            request.get("decision")
            if isinstance(request.get("decision"), dict)
            else None
        )
        dispatch_task_goal = request["taskGoal"]
        decision_kind = decision.get("kind") if decision else None
        prior_decision_kind = (
            _latest_decision_kind_after_latest_user(existing_session)
            if existing_session
            else None
        )
        is_decision_dispatch = decision_kind in ("rerun", "handoff") or (
            decision is None
            and prior_decision_kind in ("rerun", "handoff")
            and existing_session is not None
            and request["taskGoal"] == existing_session.get("taskGoal")
        )
        if existing_session and is_decision_dispatch:
            dispatch_task_goal = latest_user_turn_text(existing_session) or request["taskGoal"]
        elif existing_session and request.get("_resumedPreparedNewThread") is not True:
            stable_event_id = request.get("_admissionId") or round_id
            message_id = request.get("userMessageId") or (
                f"evt_{stable_event_id}" if stable_event_id else None
            )
            message_exists = bool(
                message_id
                and any(
                    event.get("type") == "user.message"
                    and event.get("id") == message_id
                    for event in current_session.get("events", [])
                )
            )
            if not message_exists:
                controller.record_user_message(
                    session_id,
                    request["taskGoal"],
                    actor_employee_id=actor_employee_id,
                    message_id=message_id,
                )
            controller.continue_session(session_id)
        if decision:
            self._record_run_decision(
                controller,
                session_id,
                decision,
                request["assignments"],
                round_id=request.get("_admissionId") or round_id,
            )
        if manifest:
            controller.record_collaboration_round_started(session_id, manifest)
        return dispatch_task_goal

    @staticmethod
    def _record_run_decision(
        controller: SessionController,
        session_id: str,
        decision: dict[str, Any],
        assignments: list[dict[str, Any]],
        *,
        round_id: str | None = None,
    ) -> None:
        kind = decision.get("kind")
        note = decision.get("note") if isinstance(decision.get("note"), str) else None
        target_agent = valid_agent(decision.get("targetAgent"))
        decision_id = f"dec_{round_id}" if round_id else None
        if kind == "rerun":
            controller.record_decision(
                session_id,
                "rerun",
                note,
                target_agent,
                decision_id=decision_id,
            )
        elif kind == "handoff" and target_agent:
            controller.handoff_session(
                session_id,
                target_agent,
                assignments,
                note,
                decision.get("targetAgentId"),
                decision_id=decision_id,
            )

    def _prepare_run_request(
        self,
        sandbox_id: str,
        session_id: str,
        task_goal: str,
        request: dict[str, Any],
        active_runs_by_node: dict[str, list[dict[str, Any]]],
        run_request_id: str | None,
    ) -> dict[str, Any]:
        task_id = request.get("taskId")
        if not isinstance(task_id, str) or not task_id:
            task_id = None
        node_id = sandbox_id
        if request["assignments"]:
            node_id = request["assignments"][0].get("daemonNodeId") or sandbox_id
        state = initial_agent_state(task_goal)
        if not request.get("sessionId"):
            state[COLLABORATION_NEW_SESSION_STATE_KEY] = True
        collaboration = request.get("collaboration")
        if isinstance(collaboration, dict) and isinstance(
            collaboration.get("manifest"), dict
        ):
            state[COLLABORATION_MANIFEST_STATE_KEY] = collaboration["manifest"]
        fingerprint = request.get("idempotencyFingerprint")
        if isinstance(fingerprint, str) and fingerprint:
            state[COLLABORATION_FINGERPRINT_STATE_KEY] = fingerprint
        return self.registry.prepare_run_request(
            sandbox_id,
            session_id,
            task_goal,
            request["assignments"],
            state,
            task_id,
            active_runs=active_runs_by_node[node_id],
            request_id=run_request_id,
        )

    def cancel_run(
        self,
        sandbox_id: str,
        session_id: str,
        reason: str,
        actor_employee_id: str | None = None,
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
        if actor_employee_id:
            assert_session_owned_by_employee(
                self.registry.store, session_id, actor_employee_id
            )
        request = self.registry.daemon_store.active_run_request_for_session_any_node(
            session_id
        )
        if request:
            self.registry.cancel_run_request_before_delivery(request["id"], reason)
        active = self.registry.cancel_active_run(sandbox_id, session_id, reason)
        if not active:
            session = self.registry.store.get_session(session_id)
            if session.get("status") in ("completed", "failed", "cancelled"):
                return session
            return None
        return self.registry.store.get_session(session_id)


# Fixed namespace for deriving idempotent run-request ids. Changing it would
# make in-flight keys resolve to a different request and dispatch twice.
_IDEMPOTENT_RUN_REQUEST_NAMESPACE = UUID("6f5c9d2e-1a47-4b8e-9c30-5d7ab1e84f62")


def _idempotent_run_request_id(idempotency_key: str) -> str:
    """Derive the run request's primary key from a caller's idempotency key.

    ``daemon_run_requests.id`` is a native uuid column, so this must be a real
    uuid: a prefixed digest makes Postgres reject every lookup and insert with
    InvalidTextRepresentation, failing the dispatch outright. uuid5 keeps the
    property that matters — the same key always resolves to the same request.
    """
    return str(uuid5(_IDEMPOTENT_RUN_REQUEST_NAMESPACE, idempotency_key))


def assert_session_owned_by_employee(
    store: SessionStore, session_id: str, employee_id: str
) -> None:
    try:
        session = store.get_session(session_id)
    except Exception as exc:
        raise PermissionError(
            f"Session {session_id} could not be verified for {employee_id}."
        ) from exc
    if not session.get("ownerEmployeeId"):
        raise PermissionError(
            f"Session {session_id} has no owner; {employee_id} is not authorized to run it."
        )
    if session["ownerEmployeeId"] != employee_id:
        raise PermissionError(
            f"Session {session_id} is owned by {session['ownerEmployeeId']}; {employee_id} is not authorized to run it."
        )


def session_owner_employee_id(store: SessionStore, session_id: str) -> str:
    session = store.get_session(session_id)
    owner = session.get("ownerEmployeeId")
    if not owner:
        raise PermissionError(
            f"Session {session_id} has no owner; cannot start daemon run."
        )
    return owner


def _latest_decision_kind_after_latest_user(session: dict[str, Any]) -> str | None:
    latest_user = latest_user_turn_marker(session)
    latest: tuple[tuple[str, int], str] | None = None
    for index, event in enumerate(session.get("events", [])):
        if event.get("type") != "human.decision":
            continue
        marker = (event.get("timestamp") or "", index)
        if latest_user and marker <= latest_user:
            continue
        decision = event.get("decision") or {}
        kind = decision.get("kind")
        if not isinstance(kind, str):
            continue
        if latest is None or marker > latest[0]:
            latest = (marker, kind)
    return latest[1] if latest else None
