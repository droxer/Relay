"""The run request a round hands the backend, carrying its manifest."""

from __future__ import annotations

from copy import deepcopy
from typing import Any

from ..core.ids import new_relay_id
from ..sessions.handoff_context import capture_handoff_context
from ..security.actor import Actor
from .errors import CollaborationError
from .intake import _PreparedRound
from .manifest import create_round_manifest
from .models import (
    COLLABORATION_FINGERPRINT_STATE_KEY,
    COLLABORATION_MANIFEST_STATE_KEY,
)
from .state import ConductorState


class RoundRequestMixin(ConductorState):
    def _round_request(
        self,
        intent: _PreparedRound,
        actor: Actor,
        fingerprint: str,
        *,
        session: dict[str, Any] | None,
        task_goal: str,
        resolved: list[dict[str, Any]],
        team_id: str | None,
        team_snapshot: dict[str, Any] | None,
        project_snapshot: dict[str, Any] | None,
        required_node_id: str | None,
        is_recovery: bool,
        answered_task: dict[str, Any] | None,
    ) -> dict[str, Any]:
        """The run request handed to the backend, carrying the round manifest."""
        collaboration_id = new_relay_id("col")
        round_id = new_relay_id("round")
        manifest = create_round_manifest(
            source=intent.source,
            purpose=intent.purpose,
            address=intent.address,
            assignments=resolved,
            team_snapshot=team_snapshot,
            project_snapshot=project_snapshot,
            collaboration_id=collaboration_id,
            round_id=round_id,
        )
        if intent.project_setup is not None:
            manifest = {**manifest, "projectSetup": intent.project_setup}
        task_id, scope_fields = self._round_work_scope(
            intent, session, is_recovery, answered_task
        )
        manifest = {**manifest, **scope_fields}
        handoff_context = self._handoff_context(
            intent, session, fingerprint, resolved[0], task_id, round_id
        )
        if handoff_context is not None:
            manifest = {**manifest, "handoffContext": handoff_context}
        return _round_payload(
            intent,
            actor,
            fingerprint,
            task_goal=task_goal,
            resolved=resolved,
            manifest=manifest,
            required_node_id=required_node_id,
            task_id=task_id,
            team_id=team_id,
            project_snapshot=project_snapshot,
        )

    def _handoff_context(
        self,
        intent: _PreparedRound,
        session: dict[str, Any] | None,
        fingerprint: str,
        target: dict[str, Any],
        task_id: str | None,
        round_id: str,
    ) -> dict[str, Any] | None:
        if not (
            session and intent.decision and intent.decision.get("kind") == "handoff"
        ):
            return None
        prepared = self.ctx.registry.daemon_store.active_run_request_for_session_any_node(
            session["id"]
        )
        frozen_context = _frozen_handoff_context(prepared, fingerprint)
        if frozen_context:
            # Do not even revalidate newer requirement lengths or reread
            # artifact snapshots for an already accepted operation.
            return deepcopy(frozen_context)
        task = self.ctx.task_store.get_task(task_id) if task_id else None
        captured = capture_handoff_context(
            session,
            target,
            intent.decision.get("note"),
            self.ctx.session_store,
            task=task,
        )
        return {**captured, "decisionId": f"dec_{round_id}"}


def _validated_decision(
    decision: dict[str, Any], target_assignment: dict[str, Any]
) -> dict[str, Any]:
    kind = decision.get("kind")
    target_agent = decision.get("targetAgent")
    if kind not in ("rerun", "handoff"):
        raise CollaborationError(
            "decision_invalid",
            "decision requires rerun or handoff.",
            status=400,
        )
    if target_agent is not None and target_agent != target_assignment["executorKind"]:
        raise CollaborationError(
            "decision_invalid",
            "decision targetAgent does not match participant.",
            status=400,
        )
    requested_target_id = decision.get("targetAgentId")
    if requested_target_id and requested_target_id != target_assignment["agentId"]:
        raise CollaborationError(
            "decision_invalid",
            "decision targetAgentId does not match participant.",
            status=400,
        )
    return {
        "kind": kind,
        "targetAgent": target_assignment["executorKind"],
        "targetAgentId": target_assignment["agentId"],
        **(
            {"note": decision["note"]}
            if isinstance(decision.get("note"), str) and decision["note"].strip()
            else {}
        ),
        **({"resume": True} if kind == "rerun" and decision.get("resume") is True else {}),
    }


def _frozen_handoff_context(
    prepared: dict[str, Any] | None, fingerprint: str
) -> dict[str, Any] | None:
    """The handoff context an already accepted retry of this request froze."""
    prepared_state = (prepared or {}).get("state") or {}
    frozen_context = (
        prepared_state.get(COLLABORATION_MANIFEST_STATE_KEY) or {}
    ).get("handoffContext")
    if (
        prepared
        and prepared.get("status") == "prepared"
        and prepared_state.get(COLLABORATION_FINGERPRINT_STATE_KEY) == fingerprint
        and frozen_context
    ):
        return frozen_context
    return None


def _round_payload(
    intent: _PreparedRound,
    actor: Actor,
    fingerprint: str,
    *,
    task_goal: str,
    resolved: list[dict[str, Any]],
    manifest: dict[str, Any],
    required_node_id: str | None,
    task_id: str | None,
    team_id: str | None,
    project_snapshot: dict[str, Any] | None,
) -> dict[str, Any]:
    parsed: dict[str, Any] = {
        "taskGoal": task_goal,
        "assignments": resolved,
        "actorUserId": actor["userId"],
        "actorIsAdmin": actor["isAdmin"],
        "agentFirst": True,
        "daemonNodeId": required_node_id or resolved[0]["daemonNodeId"],
        "collaboration": {"manifest": manifest},
        **({"sessionId": intent.session_id} if intent.session_id else {}),
        **({"taskId": task_id} if task_id is not None else {}),
        **(
            {"userMessageId": intent.user_message_id}
            if intent.user_message_id
            else {}
        ),
        "idempotencyFingerprint": fingerprint,
        **(
            {"idempotencyKey": intent.idempotency_key}
            if intent.idempotency_key
            else {}
        ),
        **({"teamId": team_id} if team_id else {}),
        **(
            {
                "projectId": project_snapshot["projectId"],
                "workspaceLayout": "project",
                "workspaceSubpath": project_snapshot["workspaceSubpath"],
            }
            if project_snapshot
            else {}
        ),
    }
    if not intent.decision:
        return parsed
    decision = _validated_decision(intent.decision, resolved[0])
    # The rerun target picks its runtime conversation back up; the registry
    # finds it and only resumes on a daemon that can.
    assignments = (
        [{**resolved[0], "resumeRun": True}, *resolved[1:]]
        if decision.get("resume")
        else resolved
    )
    return {**parsed, "assignments": assignments, "decision": decision}
