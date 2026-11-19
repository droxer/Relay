"""Validating a run's target before admission: node, assignments, logical agents, the thread's computer, and the task workspace.
"""

from __future__ import annotations

import builtins
from ...core.workflows import snapshot_team_id

from collections import defaultdict
from typing import Any


from ...core.computer_identity import computer_id
from ...core.daemon_records import ComputerNotDispatchableError, ComputerRunCapacityError
from ...core.models import AGENT_NAMES
from ..scheduling import node_accepts_run, normalize_run_capacity
from ...core.workspace_scheduling import session_workspace_key, workspace_is_contended, workspace_key
from ...core.daemon_capabilities import DAEMON_CAPABILITY_WORK_RESULTS, has_capability
from ...agents.routing import (
    placement_node,
    AgentRoutingError,
    resolve_legacy_session_computer_id,
)
from ...tasks.workspace import recorded_task_session_id, recorded_task_workspace, resolve_task_workspace
from ...agents.delegation import delegation_candidates
from ...projects.runtime import project_member_ids
from .state import NodeBackendState


class RunTargetValidationMixin(NodeBackendState):
    def _validate_logical_assignment(self, assignment: dict[str, Any]) -> None:
        if self.agent_store is None or self.agent_placement_store is None:
            raise ValueError("logical assignments require agent and placement stores")
        agent_id = assignment.get("agentId")
        if not isinstance(agent_id, str):
            raise ValueError("logical agent is disabled or missing")
        agent = self.agent_store.get_agent(agent_id)
        if not agent or agent.get("deletedAt") or not agent.get("enabled", True):
            raise ValueError("logical agent is disabled or missing")
        snapshot = assignment.get("teamSnapshot") or {}
        if snapshot.get("workflowId") and snapshot.get("workflowKind") != "predefined" and snapshot_team_id(snapshot):
            team = self.team_store.get_team(snapshot_team_id(snapshot)) if self.team_store else None
            if (not team or team.get("deletedAt") or not team.get("enabled", True)
                or team.get("ownerUserId") != snapshot.get("ownerUserId")
                or team.get("computerId") != snapshot.get("computerId")
                or agent_id not in team.get("memberAgentIds", [])):
                raise ValueError("workflow_team_unavailable")
        if requester_id := assignment.get("delegatedByAgentId"):
            requester = self.agent_store.get_agent(requester_id)
            if not requester or not requester.get("enabled", True) or requester.get("deletedAt") or (
                requester_id == agent_id
                or (requester.get("delegationAgentIds") is not None and agent_id not in requester["delegationAgentIds"])
                or requester.get("supervisorUserId") != agent.get("supervisorUserId")
                or requester.get("computerId") != agent.get("computerId")
            ):
                raise ValueError("Delegation permission is no longer available.")
            project_id = (assignment.get("projectSnapshot") or {}).get("projectId")
            if project_id:
                project = self.project_store.get_project(project_id) if self.project_store else None
                members = project_member_ids(project) if project else set()
                if agent_id not in members or requester_id not in members:
                    raise ValueError("project_agent_not_member")
        if agent.get("toolPolicy"):
            raise ValueError(
                "agent_policy_unsupported: logical agent policy is not enforceable by this runtime"
            )
        if agent.get("executorKind") != assignment.get("executorKind"):
            raise ValueError("logical agent executor changed")
        if agent.get("version") != assignment.get("agentVersion"):
            raise ValueError("logical agent version changed")
        placement_id = assignment.get("placementId")
        if not isinstance(placement_id, str):
            raise ValueError("placement is not active")
        placement = self.agent_placement_store.get_placement(placement_id)
        if not placement or placement.get("desiredState") != "active":
            raise ValueError("placement is not active")

        current_node = placement_node(
            placement,
            {node["id"]: node for node in self.registry.monitor_nodes()},
        )
        if (
            placement.get("agentId") != agent.get("id")
            or placement.get("supervisorUserId")
            != agent.get("supervisorUserId")
            or not current_node
            or current_node["id"] != assignment.get("daemonNodeId")
            or placement.get("executorKind") != agent.get("executorKind")
        ):
            raise ValueError("placement no longer matches the selected agent and node")
        # The match check above pinned daemonNodeId to the current node's id.
        if not self.registry.get(current_node["id"]):
            raise ValueError("daemon node is no longer available")

    def _task_workspace_request(
        self, request: dict[str, Any], node: dict[str, Any]
    ) -> dict[str, Any]:
        """Enforce affinity at admission, including callers outside task dispatch."""

        if not request.get("taskId") or not self.registry.task_store:
            return request
        task = self.registry.task_store.get_task(request["taskId"])
        actor = request.get("actorUserId")
        if (
            actor
            and not request.get("actorIsAdmin")
            and actor
            not in (task.get("ownerUserId"), task.get("assigneeUserId"))
        ):
            raise PermissionError("Task belongs to another user.")
        binding = recorded_task_workspace(
            task, self.registry.store, self.registry.monitor_nodes()
        )
        if binding and binding.get("unbound"):
            binding = {
                **{key: value for key, value in binding.items() if key != "unbound"},
                "computerId": computer_id(node),
                **(
                    {"workspaceRoot": node["workspacePath"]}
                    if node.get("workspacePath") else {}
                ),
            }
        # Project identity is supplied only by the authorized project dispatch path.
        project = None
        if request.get("projectId") and request.get("workspaceLayout") == "project":
            project = {"workspaceSubpath": request.get("workspaceSubpath")}
        layout, subpath = resolve_task_workspace(
            {**task, **({"workspaceBinding": binding} if binding else {})},
            node=node,
            project_snapshot=project,
        )
        session_id = recorded_task_session_id(task, self.registry.store)
        if session_id:
            requested_session = request.get("sessionId")
            if requested_session and requested_session != session_id:
                raise ValueError(
                    "workspace_unavailable: this task must continue in its original thread."
                )
            request = {**request, "sessionId": session_id}
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

    def _project_task_delegation_request(self, request: dict[str, Any]) -> dict[str, Any]:
        """Manual and scheduled Project work share the individual delegation contract."""
        collaboration = request.get("collaboration") or {}
        manifest = collaboration.get("manifest") or {}
        assignments = request["assignments"]
        if (
            not request.get("taskId") or not request.get("projectId")
            or len(assignments) != 1 or manifest.get("teamSnapshot") or manifest.get("workflow")
            or manifest.get("projectSetup") or "delegationCandidates" in manifest
            or assignments[0].get("mode", "action") != "action"
            or not assignments[0].get("agentId")
        ):
            return request
        project = self.project_store.get_project(request["projectId"]) if self.project_store else None
        if not project:
            return request
        candidates = delegation_candidates(self, assignments[0], project=project)
        return {**request, "collaboration": {**collaboration, "manifest": {
            **manifest, "delegationCandidates": candidates,
        }}}

    def _active_runs_by_node(self) -> dict[str, builtins.list[dict[str, Any]]]:
        active_runs_by_node: dict[str, builtins.list[dict[str, Any]]] = defaultdict(list)
        for active_run in self.registry.daemon_store.list_active_runs():
            active_runs_by_node[active_run["nodeId"]].append(active_run)
        return active_runs_by_node

    def _validate_run_target(
        self, sandbox_id: str, request: dict[str, Any]
    ) -> dict[str, Any]:
        sandbox = self.registry.get(sandbox_id)
        if not sandbox:
            raise KeyError(f"Sandbox {sandbox_id} has no registered daemon node.")
        if not sandbox.get("userId") and request.get("agentFirst") is not True:
            raise ValueError(
                f"Sandbox {sandbox_id} daemon node is not assigned to a user."
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
        active_runs_by_node: dict[str, builtins.list[dict[str, Any]]],
    ) -> None:
        for assignment in request["assignments"]:
            node_id = assignment.get("daemonNodeId") or sandbox_id
            node = self.registry.get(node_id)
            assert node is not None
            if (assignment.get("teamSnapshot") or {}).get("workContractVersion") == 1 and not has_capability(node, DAEMON_CAPABILITY_WORK_RESULTS):
                raise ValueError("This team requires a daemon with work-results support. Upgrade the daemon before dispatch.")
            if assignment.get("agentId"):
                self._validate_logical_assignment(assignment)
            if not self.registry.is_live(node_id):
                raise ComputerNotDispatchableError(node_id, online=False)
            if not self.registry.is_dispatchable(node_id):
                raise ComputerNotDispatchableError(node_id, online=True)
            executor_kind = assignment["executorKind"]
            if executor_kind in set(node.get("disabledAgents") or []):

                raise AgentRoutingError(
                    "executor_not_ready",
                    f"Sandbox {node_id} daemon node has disabled agent(s): {executor_kind}. "
                    "Re-enable them from the admin console to dispatch work."
                )
            if executor_kind not in AGENT_NAMES or node.get("agents", {}).get(executor_kind) != "ready":
                raise ValueError(
                    f"Sandbox {node_id} does not have ready agent {executor_kind}."
                )
            workspace_deferred = self._deferrable_for_workspace(
                node, request, active_runs_by_node[node_id]
            )
            session_id = request.get("sessionId")
            active_runs = active_runs_by_node[node_id]
            if not node_accepts_run(
                node,
                active_runs=active_runs,
                session_id=session_id,
            ) and not workspace_deferred:
                raise ComputerRunCapacityError(
                    f"capacity_exhausted: Sandbox {node_id} has no available execution slot.",
                    thread_active=bool(session_id) and any(run.get("sessionId") == session_id for run in active_runs),
                )

    def _deferrable_for_workspace(
        self,
        node: dict[str, Any],
        request: dict[str, Any],
        active_runs: builtins.list[dict[str, Any]],
    ) -> bool:
        """A full node still admits a run that must wait for a held workspace.

        Admission keeps it durable and unreserved (delivery defers it until the
        holder exits), so it takes no slot an independent workspace needs. The
        deferred queue is bounded by the node's own capacity.
        """
        if request.get("workspaceLayout") == "project":
            return False
        node_id = node["id"]
        session_id = request.get("sessionId")
        node_requests = self.registry.daemon_store.list_active_run_requests(node_id)
        undelivered = [
            queued for queued in node_requests
            if not queued.get("currentCommandId") and queued.get("status") == "running"
        ]
        keys: dict[str, str | None] = {}

        def key_of_session(other: str) -> str | None:
            if other not in keys:
                try:
                    keys[other] = session_workspace_key(self.registry.store.get_session_header(other))
                except KeyError:
                    keys[other] = None
            return keys[other]

        contended = workspace_is_contended(
            key=workspace_key(
                request.get("workspaceLayout"), request.get("workspaceSubpath"), session_id
            ),
            session_id=session_id,
            request_id=None,
            created_order=None,
            active_runs=active_runs,
            node_requests=node_requests,
            key_of_session=key_of_session,
            preferred_session_id=self.registry.daemon_store.preferred_workspace_session(
                node_id, request,
            ),
        )
        if contended and len(undelivered) >= normalize_run_capacity(node):
            raise ComputerRunCapacityError(
                f"capacity_exhausted: Sandbox {node_id} workspace wait queue is full."
            )
        return contended

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
