"""Building the ``run.start`` command: its fields, skill bundle, delivery bookkeeping, and the ``agent.started`` payload.
"""

from __future__ import annotations

from typing import Any
from ...collaboration.models import (
    COLLABORATION_MANIFEST_STATE_KEY,
)
from ...core.ids import new_database_id
from ...core.daemon_capabilities import (
    has_capability,
    DAEMON_CAPABILITY_AGENT_SKILLS,
)
from ..records import (
    CARRIED_RUN_REQUEST_STATE_KEYS,
)
from .run_state import (
    _DeliveryRefused,
)


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
    artifacts_dir: str | None,
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
        # None tells the daemon the workspace itself holds deliverables (a
        # project); an older daemon ignores the field and keeps `artifacts/`.
        "artifactsDir": artifacts_dir,
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
