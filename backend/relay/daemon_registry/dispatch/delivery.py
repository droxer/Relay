"""Delivering a round's current assignment to its node as a ``run.start`` command.

A mixin of ``DaemonNodeRegistry``: it shares the registry's state and locks
(declared on ``RegistryState``) and is not used on its own.
"""

from __future__ import annotations

from typing import Any
from loguru import logger
from ...collaboration.models import (
    COLLABORATION_MANIFEST_STATE_KEY,
)
from ...core.ids import new_database_id, new_relay_id, now_iso
from ...core.runtime_status import executor_not_ready_message
from ...core.next_steps import NEXT_STEPS_RELATIVE_PATH
from ...core.workspace_layout import workspace_artifacts_dir
from ...tasks.execution import request_execution_owner
from ...core.daemon_capabilities import (
    DAEMON_CAPABILITY_ROUND_RESULT,
    has_capability,
)
from ...sessions.conversation import compute_conversation_history
from ...sessions.bridge import compute_prior_agent_bridge
from ...sessions.handoff import compute_prior_handoff_note
from ...sessions.handoff_files import handoff_file
from ..scheduling import (
    effective_role_for_assignment,
    node_accepts_run,
)
from .. import config
from ..records import (
    ARTIFACT_SNAPSHOT_STATE_KEY,
    ROUND_RESULT_RELATIVE_PATH,
)
from ..state import RegistryState
from .run_state import (
    _DeliveryRefused,
    _persisted_agent_state,
    _check_workspace_support,
    _handoff_context_state,
    _agent_identity_state,
    _project_state,
    _work_item_state,
    _work_protocol_state,
    run_follow_up,
)
from .run_start import (
    _run_start_command,
    _skill_command_fields,
    _delivery_command_fields,
    _agent_started_payload,
)


class AssignmentDeliveryMixin(RegistryState):
    def _linked_workspace_path(self, session: dict[str, Any]) -> str | None:
        """A linked project's directory lives outside the node root; the
        project records where, so its artifacts name the real path."""
        project_id = session.get("projectId")
        if not project_id or self.project_store is None:
            return None
        project = self.project_store.get_project(project_id)
        if not project or project.get("workspaceSubpath") != session["workspaceSubpath"]:
            return None
        return project.get("workspaceHostPath")

    def _enqueue_current_assignment(
        self,
        run_request: dict[str, Any],
        *,
        active_runs: list[dict[str, Any]] | None = None,
        validate_logical_assignment: bool = True,
    ) -> dict[str, Any]:
        session = self.store.get_session(run_request["sessionId"])
        if session.get("deletionRequestedAt"):
            self.cancel_run_request_before_delivery(run_request["id"], "Thread deletion requested.")
            return self.daemon_store.get_run_request(run_request["id"]) or run_request
        stale = self._reject_stale_task_owner(run_request)
        if stale is not None:
            return stale
        assignments = run_request["assignments"]
        index = run_request.get("currentIndex", 0)
        if index >= len(assignments):
            self._complete_run_request(run_request, "Assignments completed.")
            return run_request
        assignment = assignments[index]
        node_id = assignment.get("daemonNodeId") or run_request["nodeId"]
        if node_id != run_request["nodeId"]:
            run_request = self.daemon_store.update_run_request(
                run_request["id"], {"nodeId": node_id}
            )
        run_id = new_database_id()
        sandbox = self._delivery_sandbox(node_id)
        if not sandbox:
            self._fail_run_request(
                run_request,
                f"Sandbox {run_request['nodeId']} was removed before the run could start.",
            )
            return run_request
        if not self._placement_admits_run(
            run_request,
            assignment,
            sandbox,
            node_id=node_id,
            index=index,
            active_runs=active_runs,
            validate_logical_assignment=validate_logical_assignment,
        ):
            return run_request
        try:
            command = self._prepare_run_start_command(
                run_request,
                assignment,
                sandbox,
                assignments=assignments,
                index=index,
                node_id=node_id,
                run_id=run_id,
            )
        except _DeliveryRefused as refusal:
            self._fail_run_request(run_request, refusal.message)
            return run_request
        return self._dispatch_run_start(run_request, node_id, command)

    def _reject_stale_task_owner(self, run_request: dict[str, Any]) -> dict[str, Any] | None:
        """Reject a request whose task now belongs to another execution; None to proceed."""
        task_id = run_request.get("taskId")
        if not (task_id and self.task_store):
            return None
        task_owner = self.task_store.get_task(task_id).get("executionOwner")
        if not task_owner or task_owner == request_execution_owner(run_request):
            return None
        # Do not fail the session: it may already belong to a newer
        # round. Reject only this stale execution request.
        rejected = self.daemon_store.update_run_request_if_status(
            run_request["id"],
            run_request["status"],
            {
                "status": "failed",
                "error": "task_ownership_changed: task execution owner changed",
            },
        )
        if rejected:
            self._close_superseded_thread(run_request["sessionId"])
        return rejected or run_request

    def _delivery_sandbox(self, node_id: str) -> dict[str, Any] | None:
        # This can run on a replica that never saw the node's heartbeats (the
        # reaper runs everywhere), so read durable liveness before judging it.
        self._hydrate_node(node_id)
        sandbox = self.sandboxes.get(node_id)
        if sandbox and not self._liveness(sandbox)["online"]:
            self._refresh_persisted_liveness(node_id)
            sandbox = self.sandboxes.get(node_id)
        return sandbox

    def _placement_admits_run(
        self,
        run_request: dict[str, Any],
        assignment: dict[str, Any],
        sandbox: dict[str, Any],
        *,
        node_id: str,
        index: int,
        active_runs: list[dict[str, Any]] | None,
        validate_logical_assignment: bool,
    ) -> bool:
        """Whether delivery may proceed; fails an ineligible placement or notes a capacity wait."""
        try:
            if (
                validate_logical_assignment
                and self.logical_assignment_validator
                and assignment.get("agentId")
            ):
                self.logical_assignment_validator(assignment)
            liveness = self._liveness(sandbox)
            if not liveness["online"]:
                raise ValueError("Runtime node heartbeat is not live.")
            if not liveness["dispatchable"]:
                raise ValueError("Runtime node is online but not taking commands.")
            if assignment["executorKind"] in set(sandbox.get("disabledAgents") or []):
                raise ValueError(
                    f"Executor {assignment['executorKind']} is disabled on this runtime node."
                )
            executor_status = (sandbox.get("agents") or {}).get(assignment["executorKind"])
            if executor_status != "ready":
                raise ValueError(
                    executor_not_ready_message(
                        assignment["executorKind"], executor_status, prefix="Executor "
                    )
                )
            node_runs = (
                active_runs
                if active_runs is not None
                else self.daemon_store.list_active_runs(node_id)
            )
            if not node_accepts_run(
                sandbox, active_runs=node_runs, session_id=run_request["sessionId"]
            ):
                # Preserve the admitted request and assignment index. Recovery
                # retries this undelivered assignment when a slot is available.
                self._note_capacity_wait(run_request, index, node_runs)
                return False
        except (KeyError, ValueError) as error:
            self._fail_run_request(
                run_request, f"Agent placement is no longer eligible: {error}"
            )
            return False
        return True

    def _prepare_run_start_command(
        self,
        run_request: dict[str, Any],
        assignment: dict[str, Any],
        sandbox: dict[str, Any],
        *,
        assignments: list[dict[str, Any]],
        index: int,
        node_id: str,
        run_id: str,
    ) -> dict[str, Any]:
        """Build the full ``run.start`` command; raises ``_DeliveryRefused``."""
        state = _persisted_agent_state(run_request["state"])
        session_snapshot = self.store.get_session(run_request["sessionId"])
        workspace_layout = session_snapshot.get("workspaceLayout") or "node-root"
        _check_workspace_support(
            sandbox, workspace_layout, session_snapshot.get("workspaceSubpath")
        )
        manifest = (run_request.get("state") or {}).get(
            COLLABORATION_MANIFEST_STATE_KEY
        ) or {}
        context = manifest.get("handoffContext")
        handoff_validation = None
        if context:
            state, handoff_validation = _handoff_context_state(
                state,
                context,
                sandbox,
                assignment,
                workspace_layout,
                session_snapshot.get("workspaceSubpath"),
            )
        else:
            state = self._conversation_prelude_state(
                state, run_request, assignment, session_snapshot, workspace_layout
            )
        request_state = run_request["state"] or {}
        state = _agent_identity_state(state, assignment, sandbox, session_snapshot)
        state = _project_state(state, manifest, assignment, assignments, sandbox, run_id)
        state = _work_item_state(state, assignment)
        state = _work_protocol_state(state, sandbox, request_state, assignments, index)
        # Only ask for the verdict where something reads it back: on a daemon
        # without the capability the file would sit in the workspace unread,
        # and the task would wait for a human either way.
        if (
            run_request.get("taskId")
            and self._assignment_reports_round_result(assignments, index)
            and has_capability(sandbox, DAEMON_CAPABILITY_ROUND_RESULT)
        ):
            state = {**state, "round_result_file": ROUND_RESULT_RELATIVE_PATH}
        # The member that speaks for the round may suggest what its person asks
        # next, in a thread as in a task. An older daemon never reads the file
        # and its prompt never asks for it, so this needs no capability.
        if self._assignment_reports_round_result(assignments, index):
            state = {**state, "next_steps_file": NEXT_STEPS_RELATIVE_PATH}
        # The role was recorded on the thread but never reached the agent, so a
        # team of specialists all received the same prompt. Carry it in the run
        # state the way the display name and instructions travel.
        role = effective_role_for_assignment(sandbox, assignment)
        if role:
            state = {**state, "agent_role": role}
        command = _run_start_command(
            run_request=run_request,
            assignment=assignment,
            sandbox=sandbox,
            session_snapshot=session_snapshot,
            node_id=node_id,
            run_id=run_id,
            state=state,
            role=role,
            workspace_layout=workspace_layout,
            artifacts_dir=self._artifacts_dir(run_request, workspace_layout, session_snapshot),
            context=context,
            handoff_validation=handoff_validation,
        )
        command = self._with_skill_bundle(command, sandbox, session_snapshot.get("projectId"))
        follow_up = run_follow_up(request_state, assignment, state)
        return {
            **command,
            **_delivery_command_fields(request_state, assignment, run_id),
            # Backend-only (underscore keys never reach the daemon): the thread
            # records it on `agent.started`.
            **({"_followUp": follow_up} if follow_up else {}),
        }

    def _artifacts_dir(
        self,
        run_request: dict[str, Any],
        workspace_layout: str,
        session_snapshot: dict[str, Any],
    ) -> str | None:
        """Where this run's deliverables go; an occurrence needs its task to know."""
        task = None
        task_id = run_request.get("taskId")
        if task_id and self.task_store and workspace_layout == "task":
            try:
                task = self.task_store.get_task(task_id)
            except (KeyError, FileNotFoundError):
                # Without the task an occurrence cannot be told from a backlog
                # task, so its run falls back to the shared `artifacts/`.
                logger.warning(
                    "run.start task lookup failed; deliverables fall back to artifacts/",
                    task_id=task_id,
                    session_id=run_request.get("sessionId"),
                )
        return workspace_artifacts_dir(
            workspace_layout, session_snapshot.get("workspaceSubpath"), task=task
        )

    def _conversation_prelude_state(
        self,
        state: dict[str, Any],
        run_request: dict[str, Any],
        assignment: dict[str, Any],
        session_snapshot: dict[str, Any],
        workspace_layout: str,
    ) -> dict[str, Any]:
        """Progress file, agent bridge, conversation, and handoff note for a run without handoff context."""
        # Chat can grow into substantial work too. Provide a stable path on
        # every run; the prompt only asks to create a checkpoint for real work.
        progress_file = handoff_file(run_request["sessionId"], workspace_layout)
        next_state = {**state, "progress_file": progress_file}
        bridge = compute_prior_agent_bridge(
            session_snapshot, assignment["executorKind"], self.store,
            progress_file=progress_file,
        )
        if bridge:
            next_state["prior_agent_bridge"] = bridge
        conversation = compute_conversation_history(
            session_snapshot, self.store, progress_file=progress_file
        )
        if conversation:
            next_state["prior_conversation"] = conversation
        handoff_note = compute_prior_handoff_note(
            session_snapshot,
            assignment["executorKind"],
            assignment.get("agentId"),
        )
        if handoff_note:
            next_state["prior_handoff_note"] = handoff_note
        return next_state

    def _with_skill_bundle(
        self, command: dict[str, Any], sandbox: dict[str, Any], project_id: str | None
    ) -> dict[str, Any]:
        logical_agent_id = command.get("logicalAgentId")
        if not (logical_agent_id and self.logical_skill_bundle_resolver):
            return command
        skill_bundle, resolution_skips = self.logical_skill_bundle_resolver(
            logical_agent_id, project_id
        )
        return {
            **command,
            **_skill_command_fields(skill_bundle, resolution_skips, sandbox),
        }

    def _dispatch_run_start(
        self, run_request: dict[str, Any], node_id: str, command: dict[str, Any]
    ) -> dict[str, Any]:
        """Claim, stage, link, and publish the command; return the latest request."""
        dispatch_claim_id = new_relay_id("claim")
        claimed_request = self.daemon_store.claim_run_request_dispatch(
            run_request["id"],
            dispatch_claim_id,
            config.DISPATCH_CLAIM_LEASE_SECONDS,
        )
        if not claimed_request:
            return self.daemon_store.get_run_request(run_request["id"]) or run_request
        run_request = claimed_request
        command = {**command, "_dispatchClaimId": dispatch_claim_id}
        staged = self.daemon_store.stage_command(
            node_id,
            command,
            request_id=run_request["id"],
            claim_id=dispatch_claim_id,
        )
        if not staged:
            return self.daemon_store.get_run_request(run_request["id"]) or run_request
        if not (
            run_request.get("taskId") and command.get("reportExecutionStarted")
        ):
            self._ensure_agent_started_for_command(run_request, command)
        updated = self.daemon_store.update_run_request_if_claimed(
            run_request["id"],
            "_relay_dispatch_claim_id",
            dispatch_claim_id,
            self._run_request_command_link(command),
        )
        if not updated:
            return self.daemon_store.get_run_request(run_request["id"]) or run_request
        # A staged command is not claimable. Publish it only after its durable
        # run-request link exists; reaping can safely publish after a crash.
        published = self.daemon_store.publish_command(
            command["id"], request_id=updated["id"]
        )
        if not published:
            return self.daemon_store.get_run_request(updated["id"]) or updated
        self._track_active_command(node_id, command)
        return updated

    def _ensure_agent_started_for_command(
        self, run_request: dict[str, Any], command: dict[str, Any]
    ) -> None:
        session = self.store.get_session(run_request["sessionId"])
        if any(
            agent_run.get("id") == command["runId"]
            for agent_run in session.get("agentRuns", [])
        ):
            return
        assignment = run_request["assignments"][run_request.get("currentIndex", 0)]
        sandbox = self.sandboxes[command["_nodeId"]]
        controller = self._controller_for_sandbox(sandbox, run_request.get("taskId"), run_request)
        # The command already carries the role the agent was told to play; the
        # thread must record that one, not a second resolution of it.
        role = command.get("role") or effective_role_for_assignment(sandbox, assignment)
        controller.record_agent_started(
            run_request["sessionId"],
            _agent_started_payload(command, assignment, sandbox, role),
        )

    def _run_request_command_link(self, command: dict[str, Any]) -> dict[str, Any]:
        state = dict(command.get("state") or {})
        artifact_snapshot = command.get("_artifactSnapshot")
        if artifact_snapshot is not None:
            state[ARTIFACT_SNAPSHOT_STATE_KEY] = artifact_snapshot
        state.update(command.get("_carriedState") or {})
        return {
            "status": "running",
            "nodeId": command["_nodeId"],
            "currentCommandId": command["id"],
            "currentRunId": command["runId"],
            "currentAgent": command["agent"],
            "currentStartedAt": now_iso(),
            "currentProgressAt": None,
            "state": state,
        }

    def _note_capacity_wait(
        self, run_request: dict[str, Any], index: int, node_runs: list[dict[str, Any]]
    ) -> None:
        """Log once which runs hold the slots a waiting assignment needs.

        The wait has no deadline (a busy computer is normal), so this is what
        tells a long one apart from a slot that is never released.
        """
        key = (run_request["id"], index)
        if key in self._logged_capacity_waits:
            return
        if len(self._logged_capacity_waits) >= config.LOGGED_CAPACITY_WAITS_MAX:
            self._logged_capacity_waits.clear()
        self._logged_capacity_waits.add(key)
        logger.info(
            "Next assignment is waiting for a run slot",
            run_request_id=run_request["id"],
            session_id=run_request["sessionId"],
            node_id=run_request["nodeId"],
            current_index=index,
            blocking_run_ids=[run.get("runId") for run in node_runs],
            same_session=[
                run.get("runId") for run in node_runs
                if run.get("sessionId") == run_request["sessionId"]
            ],
        )
