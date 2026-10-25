"""Recording a run's intent: its session controller and thread, the user message or decision, and the prepared run request.
"""

from __future__ import annotations

import builtins
from typing import Any


from ...collaboration.models import (
    COLLABORATION_FINGERPRINT_STATE_KEY,
    COLLABORATION_MANIFEST_STATE_KEY,
    COLLABORATION_NEW_SESSION_STATE_KEY,
)
from ...core.computer_identity import computer_id
from ...persistence.validation import valid_agent
from ...sessions.agent_state import initial_agent_state
from ...sessions.controller import SessionController
from ...sessions.bridge import latest_user_turn_marker, latest_user_turn_text
from .state import NodeBackendState


class RunIntentMixin(NodeBackendState):
    def _run_controller(
        self,
        sandbox_id: str,
        sandbox: dict[str, Any],
        request: dict[str, Any],
        owner_user_id: str | None,
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
            owner_user_id=owner_user_id,
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
        actor_user_id: str | None,
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
                    actor_user_id=actor_user_id,
                    message_id=message_id,
                )
            controller.continue_session(session_id)
        if decision:
            self._record_run_decision(
                controller,
                session_id,
                decision,
                request["assignments"],
                round_id=(round_id if manifest and manifest.get("handoffContext") else request.get("_admissionId") or round_id),
                actor_user_id=actor_user_id,
            )
        if manifest:
            controller.record_collaboration_round_started(session_id, manifest)
        return dispatch_task_goal

    @staticmethod
    def _record_run_decision(
        controller: SessionController,
        session_id: str,
        decision: dict[str, Any],
        assignments: builtins.list[dict[str, Any]],
        *,
        round_id: str | None = None,
        actor_user_id: str | None = None,
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
                actor_user_id=actor_user_id,
            )
        elif kind == "handoff" and target_agent:
            controller.handoff_session(
                session_id,
                target_agent,
                assignments,
                note,
                decision.get("targetAgentId"),
                decision_id=decision_id,
                actor_user_id=actor_user_id,
            )

    def _prepare_run_request(
        self,
        sandbox_id: str,
        session_id: str,
        task_goal: str,
        request: dict[str, Any],
        active_runs_by_node: dict[str, builtins.list[dict[str, Any]]],
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
        # Set only by the conductor when an approval resumes a parked round
        # (ADR-023): the work so far, and the turn to pick up at.
        resume = request.get("_resume") or {}
        state.update(resume.get("state") or {})
        return self.registry.prepare_run_request(
            sandbox_id,
            session_id,
            task_goal,
            request["assignments"],
            state,
            task_id,
            active_runs=active_runs_by_node[node_id],
            request_id=run_request_id,
            start_index=resume.get("index", 0),
        )


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
