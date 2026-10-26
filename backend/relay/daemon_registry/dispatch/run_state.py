"""The state a ``run.start`` command carries: workspace, handoff, identity, project, and work-protocol fields.

Pure helpers for ``delivery.py``; each refuses an assignment its node cannot honor
by raising ``_DeliveryRefused``.
"""

from __future__ import annotations

from copy import deepcopy
from typing import Any
from ...collaboration.work import (
    WORK_PROTOCOL, WORK_RESULTS, work_repair_notes,
    QUESTION_RESUME, QUESTION_NOTE, predecessor_context,
)
from ...collaboration.policy import (
    REPAIR_NOTE_STATE_KEY,
    REPORT_REMINDER_NOTE,
    REPORT_REMINDER_TARGET_STATE_KEY,
)
from ...projects.context import (
    project_context_brief,
)
from ...core.daemon_capabilities import (
    DAEMON_CAPABILITY_AGENT_MODEL,
    DAEMON_CAPABILITY_AGENT_RESUME,
    DAEMON_CAPABILITY_HANDOFF_VALIDATION,
    DAEMON_CAPABILITY_PROJECT_SETUP,
    DAEMON_CAPABILITY_THREAD_WORKSPACES,
    has_capability,
    DAEMON_CAPABILITY_WORK_RESULTS,
)
from ...core.workspace_capabilities import required_workspace_capabilities
from ...sessions.handoff_receipt import render_handoff_receipt
from ..records import (
    PERSISTED_AGENT_STATE_KEYS,
    ROUND_RESULT_RELATIVE_PATH,
    resumable_runtime_session,
)



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
        **({"mode": setup_block["mode"]} if setup_block.get("mode") == "plan" else {}),
        **(
            {"openTasks": setup_block.get("openTasks") or []}
            if setup_block.get("mode") == "plan"
            else {}
        ),
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


def run_follow_up(
    request_state: dict[str, Any], assignment: dict[str, Any], state: dict[str, Any]
) -> str | None:
    """Why Relay itself started this turn, if it is a rerun of the same step.

    The thread names it so the turn never reads as more of the answer the
    agent already finished: ``report_reminder`` asks for the report the last
    turn left out, ``repair`` retries a step that failed or was refused.
    """
    if request_state.get(REPORT_REMINDER_TARGET_STATE_KEY) == assignment["assignmentId"]:
        return "report_reminder"
    if state.get("repair_note"):
        return "repair"
    return None
