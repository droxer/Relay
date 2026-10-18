"""Delivering a round's current assignment to its node as a command, and retrying a follow-up that failed to start.

A mixin of ``DaemonNodeRegistry``: it shares the registry's state and locks
(declared on ``RegistryState``) and is not used on its own.
"""

from __future__ import annotations

from copy import deepcopy
from datetime import datetime, timedelta, UTC
from typing import Any
from loguru import logger
from ..collaboration.models import (
    COLLABORATION_MANIFEST_STATE_KEY,
)
from ..collaboration.work import (
    WORK_PROTOCOL, WORK_RESULTS, work_repair_notes,
    QUESTION_RESUME, QUESTION_NOTE, predecessor_context,
)
from ..collaboration.policy import (
    REPAIR_NOTE_STATE_KEY,
    REPORT_REMINDER_NOTE,
    REPORT_REMINDER_TARGET_STATE_KEY,
)
from ..core.computer_identity import computer_id
from ..core.ids import new_database_id, new_relay_id, now_iso
from ..persistence.tables.daemon import ACTIVE_RUN_REQUEST_STATUSES
from ..persistence.task_execution import (
    request_execution_owner,
)
from ..services.project_context import (
    project_context_brief,
)
from ..core.daemon_capabilities import (
    DAEMON_CAPABILITY_AGENT_MODEL,
    DAEMON_CAPABILITY_AGENT_RESUME,
    DAEMON_CAPABILITY_HANDOFF_VALIDATION,
    DAEMON_CAPABILITY_PROJECT_SETUP,
    DAEMON_CAPABILITY_ROUND_RESULT,
    DAEMON_CAPABILITY_THREAD_WORKSPACES,
    has_capability,
    DAEMON_CAPABILITY_AGENT_SKILLS,
    DAEMON_CAPABILITY_WORK_RESULTS,
)
from ..services.workspace_capabilities import required_workspace_capabilities
from ..sessions.controller import SessionController
from ..sessions.conversation import compute_conversation_history
from ..sessions.bridge import compute_prior_agent_bridge
from ..sessions.handoff import compute_prior_handoff_note
from ..sessions.handoff_files import handoff_file
from .scheduling import (
    effective_role_for_assignment,
    node_accepts_run,
)
from ..sessions.handoff_receipt import render_handoff_receipt
from . import config
from .records import (
    ARTIFACT_SNAPSHOT_STATE_KEY,
    CARRIED_RUN_REQUEST_STATE_KEYS,
    FOLLOW_UP_FAILURE_STATE_KEY,
    PERSISTED_AGENT_STATE_KEYS,
    ROUND_RESULT_RELATIVE_PATH,
    resumable_runtime_session,
)
from .state import RegistryState


_HANDOFF_CONTEXT_CONTRACTS = (
    {"name": "relay.handoff.context", "version": 1},
    {"name": "relay.handoff.context", "version": 2},
    {"name": "relay.handoff.context", "version": 3},
)
# The accepted handoff context replaces every legacy prelude, including a
# stale carried handoff note.
_LEGACY_PRELUDE_STATE_KEYS = (
    "prior_conversation",
    "prior_agent_bridge",
    "prior_handoff_note",
)
_WORK_MESSAGE_TEXT_LIMIT = 700
_WORK_MESSAGES_LIMIT = 20


class _DeliveryRefused(Exception):
    """The assignment cannot be delivered; ``message`` fails its run request."""

    def __init__(self, message: str) -> None:
        super().__init__(message)
        self.message = message


def _persisted_agent_state(request_state: dict[str, Any] | None) -> dict[str, Any]:
    return {
        key: value
        for key, value in (request_state or {}).items()
        if key in PERSISTED_AGENT_STATE_KEYS
    }


def _check_workspace_support(
    sandbox: dict[str, Any], workspace_layout: str, workspace_subpath: Any
) -> None:
    """Refuse a workspace layout the node's daemon cannot honor."""
    if workspace_layout == "thread" and not has_capability(
        sandbox, DAEMON_CAPABILITY_THREAD_WORKSPACES
    ):
        raise _DeliveryRefused(
            "The thread requires a daemon with thread-workspaces support."
        )
    if workspace_layout not in ("project", "task"):
        return
    for required_capability in required_workspace_capabilities(
        workspace_layout, workspace_subpath
    ):
        if not has_capability(sandbox, required_capability):
            raise _DeliveryRefused(
                f"The {workspace_layout} requires a daemon with "
                f"{required_capability} support."
            )
    if not isinstance(workspace_subpath, str) or not workspace_subpath:
        raise _DeliveryRefused(
            f"The {workspace_layout} thread is missing its workspaceSubpath."
        )


def _check_handoff_context(context: dict[str, Any], assignment: dict[str, Any]) -> None:
    if context.get("contract") not in _HANDOFF_CONTEXT_CONTRACTS:
        raise _DeliveryRefused("Unsupported handoff context version.")
    if context["contract"]["version"] >= 2 and not isinstance(
        context.get("receipt"), dict
    ):
        raise _DeliveryRefused("Handoff context is missing its required receipt.")
    if context.get("assignmentId") != assignment["assignmentId"]:
        raise _DeliveryRefused(
            "Handoff context does not match the receiving assignment."
        )


def _handoff_validation(
    context: dict[str, Any],
    sandbox: dict[str, Any],
    assignment: dict[str, Any],
    workspace_layout: str,
    workspace_subpath: Any,
) -> dict[str, Any]:
    """The daemon-side validation request a version-3 handoff receipt requires."""
    if not has_capability(sandbox, DAEMON_CAPABILITY_HANDOFF_VALIDATION):
        raise _DeliveryRefused(
            "Handoff requires a daemon with handoff-validation support. Upgrade the daemon before retrying."
        )
    receipt = context["receipt"]
    workspace = receipt.get("workspace") or {}
    if (
        receipt.get("targetAssignmentId") != assignment["assignmentId"]
        or workspace.get("layout") != workspace_layout
        or workspace.get("subpath") != workspace_subpath
    ):
        raise _DeliveryRefused(
            "Handoff receipt does not match the receiving workspace or assignment."
        )
    return {
        "contract": {"name": "relay.handoff.validation", "version": 1},
        "assignmentId": assignment["assignmentId"],
        "workspaceLayout": workspace_layout,
        "workspaceSubpath": workspace.get("subpath"),
        "artifacts": deepcopy(workspace.get("artifacts", [])),
    }


def _handoff_context_state(
    state: dict[str, Any],
    context: dict[str, Any],
    sandbox: dict[str, Any],
    assignment: dict[str, Any],
    workspace_layout: str,
    workspace_subpath: Any,
) -> tuple[dict[str, Any], dict[str, Any] | None]:
    """Run state and handoff validation for an accepted handoff context.

    The accepted context is immutable across staging and delivery retries.
    """
    _check_handoff_context(context, assignment)
    prior_conversation = context["priorContext"]
    if context.get("receipt") is not None:
        try:
            receipt_prompt = render_handoff_receipt(context["receipt"])
        except ValueError as error:
            raise _DeliveryRefused(str(error)) from error
        prior_conversation += "\n\n" + receipt_prompt
    handoff_validation = (
        _handoff_validation(
            context, sandbox, assignment, workspace_layout, workspace_subpath
        )
        if context["contract"]["version"] == 3
        else None
    )
    next_state = {
        **{
            key: value
            for key, value in state.items()
            if key not in _LEGACY_PRELUDE_STATE_KEYS
        },
        "task_goal": context["objective"],
        "progress_file": context["progressFile"],
        "prior_conversation": prior_conversation,
    }
    if context.get("note"):
        next_state["prior_handoff_note"] = "[Handoff instruction]\n" + context["note"]
    return next_state, handoff_validation


def _agent_identity_state(
    state: dict[str, Any],
    assignment: dict[str, Any],
    sandbox: dict[str, Any],
    session_snapshot: dict[str, Any],
) -> dict[str, Any]:
    """Display name, instructions, pinned model, and resumable session."""
    next_state = dict(state)
    if assignment.get("agentDisplayName"):
        next_state["agent_display_name"] = assignment["agentDisplayName"]
    if assignment.get("agentInstructions"):
        next_state["agent_instructions"] = assignment["agentInstructions"]
    if assignment.get("agentModel"):
        # A daemon that cannot pass the model on would silently run the
        # runtime default — the agent's setup would be a lie, so refuse.
        if not has_capability(sandbox, DAEMON_CAPABILITY_AGENT_MODEL):
            raise _DeliveryRefused(
                f"This agent pins the model {assignment['agentModel']}, "
                "but its computer's daemon cannot select models. Update the daemon."
            )
        next_state["agent_model"] = assignment["agentModel"]
    if assignment.get("resumeRun") and has_capability(sandbox, DAEMON_CAPABILITY_AGENT_RESUME):
        resume = resumable_runtime_session(session_snapshot, assignment)
        if resume:
            next_state["resume_session_id"] = resume
    if assignment.get("brief"):
        next_state["assignment_brief"] = assignment["brief"]
    return next_state


def _project_setup_state(setup_block: dict[str, Any], run_id: str) -> dict[str, Any]:
    return {
        "file": f".relay/project-setup-{run_id}.json",
        "intent": setup_block.get("intent", ""),
        "candidates": setup_block.get("candidates", []),
        "roles": setup_block.get("roles", []),
        **(
            {"previousProposal": setup_block["previousProposal"]}
            if setup_block.get("previousProposal")
            else {}
        ),
    }


def _project_state(
    state: dict[str, Any],
    manifest: dict[str, Any],
    assignment: dict[str, Any],
    assignments: list[dict[str, Any]],
    sandbox: dict[str, Any],
    run_id: str,
) -> dict[str, Any]:
    """The project brief and, for a setup draft, where to write the proposal."""
    next_state = dict(state)
    project_brief = project_context_brief(
        manifest.get("projectSnapshot") or assignment.get("projectSnapshot"),
        {
            item["agentId"]: item["agentDisplayName"]
            for item in assignments
            if item.get("agentId") and item.get("agentDisplayName")
        },
    )
    if project_brief:
        next_state["project_brief"] = project_brief
    setup_block = manifest.get("projectSetup")
    if setup_block:
        # Without the capability the proposal file would sit unread and
        # the setup would wait forever; refuse instead.
        if not has_capability(sandbox, DAEMON_CAPABILITY_PROJECT_SETUP):
            raise _DeliveryRefused(
                "Drafting a project setup needs a newer daemon on this computer. Update the daemon."
            )
        next_state["project_setup"] = _project_setup_state(setup_block, run_id)
    return next_state


def _work_item_state(state: dict[str, Any], assignment: dict[str, Any]) -> dict[str, Any]:
    next_state = {
        **state,
        "assignment_id": assignment["assignmentId"],
        "work_item_id": assignment.get("workItemId") or assignment["assignmentId"],
    }
    if assignment.get("delegationAuthority"):
        next_state["delegation_authority"] = assignment["delegationAuthority"]
    if "dependsOnWorkItemIds" in assignment:
        next_state["depends_on_work_item_ids"] = assignment["dependsOnWorkItemIds"]
    if assignment.get("workKind"):
        next_state["work_kind"] = assignment["workKind"]
    next_state["team_phase"] = assignment.get("phase") or "execution"
    return next_state


def _team_plan_candidates(assignments: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return [
        {
            "agentId": item.get("agentId"),
            "role": item.get("role"),
            "responsibility": item.get("brief"),
            "required": item.get("required", True),
        }
        for item in assignments[1:]
        if not item.get("synthesizer")
    ]


def _work_messages(request_state: dict[str, Any], work_item_id: str) -> list[dict[str, Any]]:
    """The latest peer messages addressed to this work item or to everyone."""
    return [
        {
            "fromWorkItemId": key,
            **message,
            "text": message["text"][:_WORK_MESSAGE_TEXT_LIMIT],
            "truncated": len(message["text"]) > _WORK_MESSAGE_TEXT_LIMIT,
        }
        for key, result in (request_state.get(WORK_RESULTS) or {}).items()
        for message in result.get("messages", [])
        if message.get("toWorkItemId") == work_item_id or not message.get("toWorkItemId")
    ][-_WORK_MESSAGES_LIMIT:]


def _work_protocol_state(
    state: dict[str, Any],
    sandbox: dict[str, Any],
    request_state: dict[str, Any],
    assignments: list[dict[str, Any]],
    index: int,
) -> dict[str, Any]:
    """Work-result contract fields and the round's repair note, if any."""
    assignment = assignments[index]
    next_state = dict(state)
    if request_state.get(WORK_PROTOCOL):
        if not has_capability(sandbox, DAEMON_CAPABILITY_WORK_RESULTS):
            raise _DeliveryRefused("This work round requires a daemon with work-results support.")
        next_state["work_result_required"] = True
        next_state["round_result_file"] = ROUND_RESULT_RELATIVE_PATH
        next_state["work_acceptance_criteria"] = assignment.get("acceptanceCriteria", [])
        next_state["work_expected_outputs"] = assignment.get("expectedOutputs", [])
        next_state["work_predecessor_results"] = predecessor_context(
            request_state, assignment.get("dependsOnWorkItemIds", [])
        )
        if (
            index == 0
            and assignment.get("coordinator")
            and len(assignments) > 1
            and not request_state.get(REPAIR_NOTE_STATE_KEY)
            and QUESTION_RESUME not in request_state
        ):
            next_state["team_plan_candidates"] = _team_plan_candidates(assignments)
        next_state["work_messages"] = _work_messages(request_state, next_state["work_item_id"])
        if request_state.get(QUESTION_NOTE):
            next_state["work_question"] = request_state[QUESTION_NOTE]
        next_state = {**next_state, **work_repair_notes(assignments, index, request_state)}
    if request_state.get(REPAIR_NOTE_STATE_KEY) and index == 0:
        next_state["repair_note"] = request_state[REPAIR_NOTE_STATE_KEY]
    if request_state.get(REPORT_REMINDER_TARGET_STATE_KEY) == assignment["assignmentId"]:
        next_state["repair_note"] = "\n\n".join(
            note for note in (next_state.get("repair_note"), REPORT_REMINDER_NOTE) if note
        )
    return next_state


def _optional_fields(source: dict[str, Any], pairs: tuple[tuple[str, str], ...]) -> dict[str, Any]:
    """``{target: source[key]}`` for each pair whose source value is truthy."""
    return {target: source[key] for key, target in pairs if source.get(key)}


def _run_start_command(
    *,
    run_request: dict[str, Any],
    assignment: dict[str, Any],
    sandbox: dict[str, Any],
    session_snapshot: dict[str, Any],
    node_id: str,
    run_id: str,
    state: dict[str, Any],
    role: str | None,
    workspace_layout: str,
    context: dict[str, Any] | None,
    handoff_validation: dict[str, Any] | None,
) -> dict[str, Any]:
    """The ``run.start`` command before skills and delivery bookkeeping."""
    return {
        "id": new_database_id(),
        "type": "run.start",
        "sessionId": run_request["sessionId"],
        "runId": run_id,
        "taskGoal": state.get("task_goal") or run_request["taskGoal"],
        "agent": assignment["executorKind"],
        "phase": state["team_phase"],
        "assignmentId": assignment["assignmentId"],
        "workspaceLayout": workspace_layout,
        **(
            {"workspaceSubpath": session_snapshot["workspaceSubpath"]}
            if workspace_layout in ("project", "task")
            else {}
        ),
        **({"role": role} if role else {}),
        **_optional_fields(
            assignment,
            (
                ("agentId", "logicalAgentId"),
                ("placementId", "placementId"),
                ("agentVersion", "agentVersion"),
            ),
        ),
        **_optional_fields(sandbox, (("workspacePath", "workspacePath"),)),
        "state": state,
        "_runRequestId": run_request["id"],
        "reportWorkspaceStatus": True,
        **(
            {"reportExecutionStarted": True}
            if context or run_request.get("taskId")
            else {}
        ),
        **(
            {"handoffValidation": handoff_validation}
            if handoff_validation is not None
            else {}
        ),
        "_nodeId": node_id,
    }


def _required_skill_refusal(skill: dict[str, Any], reason: str) -> _DeliveryRefused:
    return _DeliveryRefused(
        "required_skill_unavailable: "
        f"{skill.get('slug') or skill['skillId']} "
        f"({reason})"
    )


def _skill_command_fields(
    skill_bundle: dict[str, Any] | None,
    resolution_skips: list[dict[str, Any]],
    sandbox: dict[str, Any],
) -> dict[str, Any]:
    """Command fields carrying a resolved skill bundle to the daemon."""
    required_skip = next(
        (item for item in resolution_skips if item.get("assignmentMode") == "required"),
        None,
    )
    if required_skip:
        # Fail visibly like any other ineligible placement: raising here
        # escaped the eligibility guard and left the round retrying.
        raise _required_skill_refusal(required_skip, required_skip["reason"])
    fields: dict[str, Any] = {}
    if skill_bundle is None:
        pass
    elif has_capability(sandbox, DAEMON_CAPABILITY_AGENT_SKILLS):
        fields = {"skills": skill_bundle, "_skillsSkipped": resolution_skips}
    else:
        bundle_skills = skill_bundle.get("skills", [])
        required = next(
            (skill for skill in bundle_skills if skill.get("assignmentMode") == "required"),
            None,
        )
        if required:
            raise _required_skill_refusal(required, "daemon-unsupported")
        unsupported = [
            {"skillId": skill["skillId"], "slug": skill.get("slug"), "reason": "daemon-unsupported"}
            for skill in bundle_skills
        ]
        fields = {"_skillsSkipped": [*resolution_skips, *unsupported]}
    if skill_bundle is not None or resolution_skips:
        fields = {**fields, "reportExecutionStarted": True}
    return fields


def _delivery_command_fields(
    request_state: dict[str, Any], assignment: dict[str, Any], run_id: str
) -> dict[str, Any]:
    """Delivery attempt, artifact, and carried-state fields of the command."""
    collaboration_manifest = request_state.get(COLLABORATION_MANIFEST_STATE_KEY)
    delivery = (
        {
            "delivery": {
                "type": "assignment-attempt",
                "attemptId": run_id,
                "collaborationId": collaboration_manifest.get("collaborationId"),
                "roundId": collaboration_manifest.get("roundId"),
                "assignmentId": assignment["assignmentId"],
                "workItemId": assignment.get("workItemId") or assignment["assignmentId"],
            }
        }
        if isinstance(collaboration_manifest, dict)
        else {}
    )
    return {
        **delivery,
        # Artifact collection belongs to the daemon, including old runtimes.
        # Never interpret a daemon workspace path as a backend-host directory.
        "_artifactSnapshot": None,
        "_carriedState": {
            key: value
            for key, value in request_state.items()
            if key in CARRIED_RUN_REQUEST_STATE_KEYS
        },
    }


def _agent_started_payload(
    command: dict[str, Any],
    assignment: dict[str, Any],
    sandbox: dict[str, Any],
    role: str | None,
) -> dict[str, Any]:
    return {
        "runId": command["runId"],
        **({"consultation": True} if (command.get("state") or {}).get("work_question") else {}),
        "assignmentId": assignment["assignmentId"],
        "workItemId": assignment.get("workItemId") or assignment["assignmentId"],
        "agent": command["agent"],
        **({"role": role} if role else {}),
        "teamPhase": command["phase"],
        **_optional_fields(
            command,
            (("logicalAgentId", "logicalAgentId"), ("placementId", "placementId")),
        ),
        "daemonNodeId": command["_nodeId"],
        **_optional_fields(sandbox, (("managedNodeId", "managedNodeId"),)),
        **_optional_fields(command, (("agentVersion", "agentVersion"),)),
        **_optional_fields(
            assignment,
            (
                ("brief", "brief"),
                ("delegationAuthority", "delegationAuthority"),
            ),
        ),
        **(
            {"dependsOnWorkItemIds": assignment["dependsOnWorkItemIds"]}
            if "dependsOnWorkItemIds" in assignment
            else {}
        ),
        **_optional_fields(assignment, (("workKind", "workKind"),)),
        **({"coordinator": True} if assignment.get("coordinator") is True else {}),
        **({"synthesizer": True} if assignment.get("synthesizer") is True else {}),
        **(
            {"teamSnapshot": assignment["teamSnapshot"]}
            if isinstance(assignment.get("teamSnapshot"), dict)
            else {}
        ),
    }


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
            if not self._liveness(sandbox)["online"]:
                raise ValueError("Runtime node heartbeat is not live.")
            if assignment["executorKind"] in set(sandbox.get("disabledAgents") or []):
                raise ValueError(
                    f"Executor {assignment['executorKind']} is disabled on this runtime node."
                )
            if (sandbox.get("agents") or {}).get(assignment["executorKind"]) != "ready":
                raise ValueError(
                    f"Executor {assignment['executorKind']} is not ready on this runtime node."
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
            context=context,
            handoff_validation=handoff_validation,
        )
        command = self._with_skill_bundle(command, sandbox, session_snapshot.get("projectId"))
        return {**command, **_delivery_command_fields(request_state, assignment, run_id)}

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

    def _close_superseded_thread(self, session_id: str) -> None:
        """Close a thread whose round lost its task to a newer execution.

        With no other request active the thread would read `running` forever.
        The controller carries no task: the task belongs to its new owner.
        """
        if self.daemon_store.active_run_request_for_session_any_node(session_id):
            return
        if self.store.get_session(session_id).get("status") != "running":
            return
        # Not a cancel: that is a human decision and must name its actor.
        SessionController(self.store).fail_session(
            session_id, "This round stopped because its task moved to another run."
        )

    def _follow_up_run_request(
        self, run_request: dict[str, Any], outcome: str = "Assignments completed."
    ) -> None:
        """Start the request's current assignment, or close the round past its end.

        Runs after finalization has released its terminal claim, so a failure
        here is outside that claim's attempt counting. Count it on the request
        instead: a deterministic error used to leave the thread `running` with
        the reaper retrying forever and nothing visible to anyone.
        """
        try:
            if run_request.get("currentIndex", 0) >= len(run_request["assignments"]):
                self._complete_run_request(run_request, outcome)
            else:
                self._enqueue_current_assignment(run_request)
        except Exception as error:
            # Record before re-raising: the caller's own handling (the claim
            # handler, the reaper's log) cannot count it.
            self._record_follow_up_failure(run_request, error)
            raise

    @staticmethod
    def _follow_up_backing_off(run_request: dict[str, Any]) -> bool:
        failure = (run_request.get("state") or {}).get(FOLLOW_UP_FAILURE_STATE_KEY)
        if not isinstance(failure, dict) or failure.get("index") != run_request.get("currentIndex", 0):
            return False
        retry_at = failure.get("retryAt")
        return isinstance(retry_at, str) and datetime.fromisoformat(retry_at) > datetime.now(UTC)

    def _record_follow_up_failure(self, run_request: dict[str, Any], error: Exception) -> None:
        logger.exception(
            "Could not continue a run request after finalization",
            run_request_id=run_request["id"],
            session_id=run_request.get("sessionId"),
            current_index=run_request.get("currentIndex", 0),
        )
        current = self.daemon_store.get_run_request(run_request["id"])
        if not current or current.get("status") not in ACTIVE_RUN_REQUEST_STATUSES:
            return
        index = current.get("currentIndex", 0)
        state = dict(current.get("state") or {})
        previous = state.get(FOLLOW_UP_FAILURE_STATE_KEY)
        attempts = (
            int(previous.get("attempts") or 0)
            if isinstance(previous, dict) and previous.get("index") == index
            else 0
        ) + 1
        if attempts >= config.MAX_FOLLOW_UP_ATTEMPTS:
            try:
                self._fail_run_request(
                    current,
                    f"The round could not continue after {attempts} attempts: {str(error)[:500]}",
                )
            except Exception:  # noqa: BLE001 - nothing more to do than report it
                logger.exception(
                    "Could not fail a run request that cannot continue",
                    run_request_id=current["id"],
                )
            return
        # A transient error retries on the next recovery pass; a repeating one
        # backs off until the cap fails the thread.
        retry_at = datetime.now(UTC) + timedelta(
            seconds=0 if attempts == 1 else min(300, 5 * 2 ** (attempts - 2))
        )
        state[FOLLOW_UP_FAILURE_STATE_KEY] = {
            "index": index,
            "attempts": attempts,
            "retryAt": retry_at.isoformat(),
            "error": str(error)[:500],
        }
        self.daemon_store.update_run_request_if_status(
            current["id"], current["status"], {"state": state}
        )

    def _controller_for_sandbox(
        self, sandbox: dict[str, Any], task_id: str | None = None,
        run_request: dict[str, Any] | None = None,
    ) -> SessionController:

        return SessionController(
            self.store,
            task_store=self.task_store,
            task_id=task_id,
            task_execution_owner=request_execution_owner(run_request) if run_request else None,
            workspace_path=sandbox.get("workspacePath") or "/workspace",
            owner_user_id=sandbox.get("userId"),
            daemon_node_id=sandbox.get("id"),
            managed_node_id=sandbox.get("managedNodeId"),
            computer_id=computer_id(sandbox),
        )
