from __future__ import annotations

import hashlib
import json
from copy import deepcopy
from dataclasses import asdict, dataclass, field, replace
from typing import Any

from ..core.computer_identity import computer_id
from ..core.human_waits import QUESTION_ID_PREFIX
from ..core.ids import new_database_id, new_relay_id
from ..services.agent_location import agent_computer_ids
from ..services.agent_routing import (
    AgentRoutingError,
    persist_legacy_session_computer_id,
    resolve_agent_assignments,
    resolve_session_daemon_node_id,
)
from ..services.project_runtime import (
    ProjectDispatchError,
    project_member_ids,
    project_thread_assignments,
    project_runtime_node,
    project_task_assignment_error,
    project_runtime_snapshot,
)
from ..services.team_dispatch import (
    TeamDispatchError,
    team_agents,
    team_assignment_phase,
    team_member_assignments,
    team_runtime_snapshot,
)
from ..sessions.bridge import latest_user_turn_text
from ..sessions.controller import SessionController
from ..sessions.handoff_context import capture_handoff_context
from .models import (
    COLLABORATION_FINGERPRINT_STATE_KEY,
    COLLABORATION_MANIFEST_STATE_KEY,
    CollaborationIdempotencyError,
    MessageIntent,
    RecoveryIntent,
    RunIntent,
)
from .styles import LEAD_LED, resolve_collaboration_style
from .manifest import compile_assignment_work_graph, create_round_manifest
from ..security.actor import Actor

ASSIGNMENT_BRIEF_MAX_CHARS = 4000
VALID_MODES = frozenset({"action", "ask", "review"})
VALID_ROLES = frozenset({"implementer", "reviewer", "planner", "tester", "fixer"})


def assignment_team_snapshot(
    assignments: list[dict[str, Any]],
) -> dict[str, Any] | None:
    """Return the team snapshot carried by a resolved assignment roster."""
    return next(
        (
            assignment["teamSnapshot"]
            for assignment in assignments
            if isinstance(assignment.get("teamSnapshot"), dict)
        ),
        None,
    )


class CollaborationError(ValueError):
    def __init__(self, code: str, message: str | None = None, *, status: int = 409):
        self.code = code
        self.status = status
        super().__init__(message or code)


@dataclass(frozen=True)
class _PreparedRound:
    task_goal: str
    session_id: str | None
    raw_assignments: list[dict[str, Any]] | None
    mode: str
    requested_team_id: str | None
    address_team_id: str | None
    requested_project_id: str | None
    requested_node_id: str | None
    idempotency_key: str | None
    user_message_id: str | None
    decision: dict[str, Any] | None
    source: str
    purpose: str
    address: dict[str, Any]
    style: str | None = None
    project_setup: dict[str, Any] | None = None
    question_id: str | None = None


@dataclass(frozen=True)
class _RoundRoster:
    """The participants a round resolves to, before placement."""

    raw_assignments: list[dict[str, Any]]
    team_member_ids: set[str] = field(default_factory=set)
    team_snapshot: dict[str, Any] | None = None
    project: dict[str, Any] | None = None
    project_snapshot: dict[str, Any] | None = None


class CollaborationConductor:
    """Turn semantic collaboration intent into one durable, auditable round.

    Daemon delivery remains behind ``ctx.backend`` during the compatibility
    migration. Callers no longer need to resolve a room into assignments.
    """

    def __init__(self, ctx: Any):
        self.ctx = ctx

    async def submit(
        self, intent: MessageIntent | RecoveryIntent | RunIntent, actor: Actor
    ) -> dict[str, Any]:
        prepared = self._prepare(intent)
        fingerprint = _request_fingerprint(prepared)
        if prepared.idempotency_key:
            prepared = replace(
                prepared,
                idempotency_key=_scoped_idempotency_key(
                    actor["userId"],
                    prepared.session_id,
                    prepared.idempotency_key,
                ),
            )
        try:
            if prepared.idempotency_key:
                existing = self.ctx.backend.idempotent_run(
                    prepared.idempotency_key,
                    actor["userId"],
                    actor_is_admin=actor["isAdmin"],
                    expected_fingerprint=fingerprint,
                )
                if existing:
                    return existing
            elif prepared.session_id:
                existing = self.ctx.backend.idempotent_session_run(
                    prepared.session_id,
                    actor["userId"],
                    actor_is_admin=actor["isAdmin"],
                    expected_fingerprint=fingerprint,
                )
                if existing:
                    return existing
            return await self._submit_prepared(prepared, actor, fingerprint)
        except TeamDispatchError as error:
            raise CollaborationError(error.code) from error
        except AgentRoutingError as error:
            raise CollaborationError(error.code, str(error)) from error
        except PermissionError as error:
            raise CollaborationError("forbidden", str(error), status=403) from error
        except CollaborationIdempotencyError as error:
            raise CollaborationError("idempotency_conflict", str(error)) from error
        except CollaborationError:
            raise
        except ValueError as error:
            raise CollaborationError("collaboration_conflict", str(error)) from error

    @staticmethod
    def _prepare(
        intent: MessageIntent | RecoveryIntent | RunIntent,
    ) -> _PreparedRound:
        if isinstance(intent, MessageIntent):
            return _prepare_message(intent)
        if isinstance(intent, RecoveryIntent):
            return _prepare_recovery(intent)
        return _prepare_run(intent)

    async def _submit_prepared(
        self,
        intent: _PreparedRound,
        actor: Actor,
        fingerprint: str,
    ) -> dict[str, Any]:
        session = self._session_for_actor(intent.session_id, actor)
        session = self._backfill_runtime_affinity(session)
        answered_task = (
            self._assert_current_question(session, intent.question_id)
            if intent.question_id
            else None
        )
        task_goal = _round_task_goal(intent, session)
        team_id, project_id = _round_scope_ids(intent, session)
        is_recovery = _is_recovery_decision(intent.decision)
        round_team_id = self._round_team_id(
            team_id,
            intent.address_team_id,
            intent.raw_assignments,
            retargetable=intent.source == "message",
        )
        _assert_style_allowed(intent, round_team_id)
        roster = self._round_roster(
            intent,
            session,
            actor,
            team_id=team_id,
            project_id=project_id,
            round_team_id=round_team_id,
            is_recovery=is_recovery,
            answered_task=answered_task,
        )
        daemon_nodes = self.ctx.registry.monitor_nodes()
        required_node_id = self._required_node_id(
            intent, session, roster.project, daemon_nodes
        )
        if intent.source == "message" and session and required_node_id:
            self._assert_addressed_agents_on_node(
                roster.raw_assignments,
                _room_agent_ids(session),
                required_node_id,
                daemon_nodes,
            )
        team_snapshot = _with_work_contract(
            roster.team_snapshot, intent, is_recovery, len(roster.raw_assignments)
        )
        resolved = self._resolve_round_assignments(
            intent,
            actor,
            session,
            roster,
            round_team_id=round_team_id,
            team_snapshot=team_snapshot,
            daemon_nodes=daemon_nodes,
            required_node_id=required_node_id,
        )
        parsed = self._round_request(
            intent,
            actor,
            fingerprint,
            session=session,
            task_goal=task_goal,
            resolved=resolved,
            team_id=team_id,
            team_snapshot=team_snapshot,
            project_snapshot=roster.project_snapshot,
            required_node_id=required_node_id,
            is_recovery=is_recovery,
            answered_task=answered_task,
        )
        dispatched = await self.ctx.backend.run(resolved[0]["daemonNodeId"], parsed)
        return self._admit_addressed_agents(dispatched, resolved, actor)

    def _round_roster(
        self,
        intent: _PreparedRound,
        session: dict[str, Any] | None,
        actor: Actor,
        *,
        team_id: str | None,
        project_id: str | None,
        round_team_id: str | None,
        is_recovery: bool,
        answered_task: dict[str, Any] | None,
    ) -> _RoundRoster:
        """Who takes this round: the project crew, a team, or the room."""
        raw_assignments = intent.raw_assignments
        if project_id:
            roster = self._project_roster(
                intent, session, actor, project_id, answered_task
            )
        elif round_team_id and not raw_assignments:
            roster = self._team_roster(intent, session, actor, round_team_id)
        elif round_team_id and raw_assignments:
            roster = self._addressed_team_roster(
                intent,
                session,
                actor,
                team_id=team_id,
                round_team_id=round_team_id,
                is_recovery=is_recovery,
            )
        elif session and not raw_assignments:
            roster = _RoundRoster(
                raw_assignments=_room_assignments(session, intent.mode)
            )
        else:
            roster = _RoundRoster(raw_assignments=raw_assignments or [])
        if not roster.raw_assignments:
            raise CollaborationError(
                "participants_required",
                "At least one participant is required.",
                status=400,
            )
        return roster

    def _project_roster(
        self,
        intent: _PreparedRound,
        session: dict[str, Any] | None,
        actor: Actor,
        project_id: str,
        answered_task: dict[str, Any] | None,
    ) -> _RoundRoster:
        project = self._round_project(project_id, session, actor)
        project_snapshot = project_runtime_snapshot(project)
        selected_ids = _project_selected_ids(intent.raw_assignments)
        if selected_ids is None and answered_task is not None:
            selected_ids = self._asking_outside_agent_ids(
                project, intent.question_id
            )
        if intent.project_setup is not None:
            raw_assignments = self._project_setup_assignments(
                project, selected_ids, project_snapshot
            )
        else:
            raw_assignments = self._project_room_assignments(
                intent, session, project, selected_ids, project_snapshot
            )
        return _RoundRoster(
            raw_assignments=raw_assignments,
            project=project,
            project_snapshot=project_snapshot,
        )

    def _round_project(
        self,
        project_id: str,
        session: dict[str, Any] | None,
        actor: Actor,
    ) -> dict[str, Any]:
        project = self.ctx.project_store.get_project(project_id)
        if not project or project.get("archivedAt"):
            raise CollaborationError("project_not_found", status=404)
        expected_owner = session.get("ownerUserId") if session else actor["userId"]
        if project.get("ownerUserId") != expected_owner:
            raise CollaborationError("project_forbidden", status=403)
        if not project.get("enabled", True):
            raise CollaborationError("project_disabled")
        return project

    def _project_room_assignments(
        self,
        intent: _PreparedRound,
        session: dict[str, Any] | None,
        project: dict[str, Any],
        selected_ids: list[str] | None,
        project_snapshot: dict[str, Any],
    ) -> list[dict[str, Any]]:
        try:
            return project_thread_assignments(
                project,
                mode=intent.mode,
                selected_agent_ids=selected_ids,
                room_agent_ids=_room_agent_ids(session) if session else [],
                snapshot=project_snapshot,
                agent_store=self.ctx.agent_store,
                placement_store=self.ctx.agent_placement_store,
            )
        except ProjectDispatchError as error:
            raise CollaborationError(error.code, status=400) from error

    def _team_roster(
        self,
        intent: _PreparedRound,
        session: dict[str, Any] | None,
        actor: Actor,
        round_team_id: str,
    ) -> _RoundRoster:
        """An unaddressed team round: the team's own roster and style."""
        team, members = self._team_for_round(round_team_id, session, actor)
        team_member_ids = {agent["id"] for agent in members}
        raw_assignments = team_member_assignments(
            members,
            mode=intent.mode,
            team=team,
            style=resolve_collaboration_style(team, None, intent.style),
        )
        team_snapshot = raw_assignments[0].get(
            "teamSnapshot"
        ) or team_runtime_snapshot(team, members)
        return _RoundRoster(
            raw_assignments=raw_assignments,
            team_member_ids=team_member_ids,
            team_snapshot=team_snapshot,
        )

    def _addressed_team_roster(
        self,
        intent: _PreparedRound,
        session: dict[str, Any] | None,
        actor: Actor,
        *,
        team_id: str | None,
        round_team_id: str,
        is_recovery: bool,
    ) -> _RoundRoster:
        """A team round whose participants the caller named."""
        if is_recovery:
            team, members = self._recovery_team(team_id, session, actor)
            team_member_ids = set(team.get("memberAgentIds") or [])
        else:
            team, members = self._team_for_round(round_team_id, session, actor)
            team_member_ids = {agent["id"] for agent in members}
        # An addressed accomplish round runs lead-led whatever the team's
        # own style: the lead coordinates and synthesizes below. Record
        # that, so style-aware policy treats it like any lead-led round.
        team_snapshot = team_runtime_snapshot(
            team,
            members,
            style=LEAD_LED if intent.mode == "action" and not is_recovery else None,
        )
        # Addressing chooses participants, not their specialization. Keep
        # explicit overrides, but fill in team briefs and roles. In an
        # accomplish group the addressed lead coordinates first regardless
        # of mention order, then owns the final synthesis turn.
        member_assignments = team_member_assignments(
            members, team=team, include_on_request=True, style=LEAD_LED
        )
        raw_assignments = _with_member_defaults(
            intent.raw_assignments or [], member_assignments
        )
        if (
            not is_recovery
            and intent.purpose == "accomplish"
            and len(raw_assignments) > 1
        ):
            raw_assignments = _lead_led_order(
                raw_assignments, member_assignments, team.get("leadAgentId")
            )
        return _RoundRoster(
            raw_assignments=raw_assignments,
            team_member_ids=team_member_ids,
            team_snapshot=team_snapshot,
        )

    def _recovery_team(
        self,
        team_id: str | None,
        session: dict[str, Any] | None,
        actor: Actor,
    ) -> tuple[dict[str, Any], list[dict[str, Any]]]:
        """The thread's team for a rerun or handoff, healthy or not.

        Recovery deliberately skips `team_agents`. A rerun or handoff is how a
        stuck thread gets rescued, so it must still work after the team was
        disabled or a sibling member broke; requiring the whole roster to be
        healthy would strand the thread. Ownership and membership are still
        enforced, and the target agent's own liveness is checked by
        `resolve_agent_assignments` later.
        """
        team = self.ctx.team_store.get_team(team_id)
        if not team or team.get("deletedAt"):
            raise CollaborationError("team_not_found")
        expected_owner = self._team_user_id(session, actor)
        if team.get("ownerUserId") != expected_owner:
            raise CollaborationError("team_forbidden")
        members = [
            self.ctx.agent_store.get_agent(agent_id)
            for agent_id in team.get("memberAgentIds") or []
        ]
        return team, [member for member in members if member]

    def _required_node_id(
        self,
        intent: _PreparedRound,
        session: dict[str, Any] | None,
        project: dict[str, Any] | None,
        daemon_nodes: list[dict[str, Any]],
    ) -> str | None:
        """The computer this round must run on, if one is already decided."""
        session_node_id = resolve_session_daemon_node_id(session, daemon_nodes)
        _assert_same_runtime(intent, session, session_node_id)
        project_node = project_runtime_node(project, daemon_nodes) if project else None
        if project and project_node is None:
            raise CollaborationError("project_computer_offline")
        return (
            session_node_id
            or (project_node or {}).get("id")
            or intent.requested_node_id
        )

    def _resolve_round_assignments(
        self,
        intent: _PreparedRound,
        actor: Actor,
        session: dict[str, Any] | None,
        roster: _RoundRoster,
        *,
        round_team_id: str | None,
        team_snapshot: dict[str, Any] | None,
        daemon_nodes: list[dict[str, Any]],
        required_node_id: str | None,
    ) -> list[dict[str, Any]]:
        assignments = self._compile_assignments(
            roster.raw_assignments,
            round_team_id,
            roster.team_member_ids,
            team_snapshot,
        )
        resolved = resolve_agent_assignments(
            assignments,
            user_id=actor["userId"],
            is_admin=actor["isAdmin"],
            agent_store=self.ctx.agent_store,
            placement_store=self.ctx.agent_placement_store,
            daemon_nodes=daemon_nodes,
            session=session,
            required_node_id=required_node_id,
            daemon_store=self.ctx.registry.daemon_store,
            session_store=self.ctx.session_store,
        )
        return compile_assignment_work_graph(
            resolved,
            purpose=intent.purpose,
            team_snapshot=team_snapshot,
        )

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

    def _round_work_scope(
        self,
        intent: _PreparedRound,
        session: dict[str, Any] | None,
        is_recovery: bool,
        answered_task: dict[str, Any] | None,
    ) -> tuple[str | None, dict[str, Any]]:
        """The task this round executes for, and the manifest fields naming it."""
        if session and is_recovery:
            ownership = {
                "revision": session.get("collaborationRevision", 0),
                "roundId": session.get("activeRoundId"),
            }
            scope = self._recovery_work_scope(session)
            if scope["kind"] != "task":
                return None, {"sourceOwnership": ownership, "workScope": scope}
            task = self.ctx.task_store.get_task(scope["taskId"])
            return scope["taskId"], {
                "sourceOwnership": ownership,
                "sourceTaskRevision": _execution_revision(task),
                "workScope": scope,
            }
        if session and intent.source == "message" and intent.purpose == "accomplish":
            # A reply to a task that is waiting on its human is the answer the
            # task asked for: run it as the task's next round, so the verdict
            # moves the task instead of leaving it parked forever. Discussion
            # and review messages keep their conversational scope.
            # An answer resumes exactly the task its question was checked
            # against; one read, so the check and the resume cannot disagree.
            task = answered_task or self._awaiting_task(session)
            if task:
                return task["id"], {
                    "sourceTaskRevision": _execution_revision(task),
                    "workScope": {"kind": "task", "taskId": task["id"]},
                }
        return None, {}

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

    def _project_setup_assignments(
        self,
        project: dict[str, Any],
        selected_ids: list[str] | None,
        snapshot: dict[str, Any],
    ) -> list[dict[str, Any]]:
        """The one agent drafting a project's setup.

        Setup happens before there is a crew, so the drafter is admitted by
        the rule project tasks use — any agent on the project's computer —
        rather than by roster membership.
        """
        if not selected_ids or len(selected_ids) != 1:
            raise CollaborationError("project_setup_agent_required", status=400)
        agent_id = selected_ids[0]
        error = project_task_assignment_error(
            project,
            agent_id=agent_id,
            team=None,
            placement_store=self.ctx.agent_placement_store,
        )
        if error:
            raise CollaborationError(error, status=400)
        return [
            {
                "agentId": agent_id,
                "role": "planner",
                "mode": "action",
                "phase": "execution",
                "coordinator": True,
                "brief": "Draft this project's setup for the owner to review. Do not start the project's work.",
                "projectSnapshot": snapshot,
            }
        ]

    def _asking_outside_agent_ids(
        self, project: dict[str, Any], question_id: str | None
    ) -> list[str] | None:
        """The agents of the round that asked, when it ran outside the crew.

        A run's question id derives from its run request, so an unaddressed
        answer can go back to whoever asked. A crew round keeps the room rule
        (None), so only work handed to agents off the roster changes course.
        """
        prefix = f"{QUESTION_ID_PREFIX}_"
        if not question_id or not question_id.startswith(prefix):
            return None
        request = self.ctx.registry.daemon_store.get_run_request(
            question_id[len(prefix):]
        )
        agent_ids = list(dict.fromkeys(
            item["agentId"]
            for item in (request or {}).get("assignments") or []
            if isinstance(item, dict) and isinstance(item.get("agentId"), str)
        ))
        crew = project_member_ids(project)
        if not agent_ids or all(agent_id in crew for agent_id in agent_ids):
            return None
        return agent_ids

    def _assert_current_question(
        self, session: dict[str, Any] | None, question_id: str
    ) -> dict[str, Any]:
        """Refuse an answer to a question the thread no longer waits on.

        Matching an answer by thread and task status alone let a stale reply
        (a second tab, a double send across a quick round) answer whatever the
        task asked next. Naming the question closes that.
        """
        task = self._awaiting_task(session) if session else None
        current = ((task or {}).get("waitingRequest") or {}).get("questionId")
        if task is None or current != question_id:
            raise CollaborationError(
                "question_superseded",
                "This question was already answered or replaced. "
                "Reload the thread to see what it waits on now.",
            )
        return task

    def _awaiting_task(self, session: dict[str, Any]) -> dict[str, Any] | None:
        """The task waiting on this thread's human, if a reply here resumes it.

        A wait that records its thread (`waitingSessionId`) names the room
        outright, so a status question asked in between does not orphan it.
        Older waits fall back to the active round's task scope, and a task now
        waiting in another thread never answers to this one.
        """
        session_id = session.get("id")
        for task in self.ctx.task_store.list_tasks_for_session(session_id):
            if task.get("waitingSessionId") == session_id and _resumable_wait(task):
                return task
        source_round: dict[str, Any] = next(
            (
                item
                for item in session.get("collaborationRounds", [])
                if item.get("roundId") == session.get("activeRoundId")
            ),
            {},
        )
        scope = source_round.get("workScope")
        if not (
            isinstance(scope, dict)
            and scope.get("kind") == "task"
            and isinstance(scope.get("taskId"), str)
            and scope["taskId"]
        ):
            return None
        try:
            task = self.ctx.task_store.get_task(scope["taskId"])
        except KeyError:
            return None
        if not _resumable_wait(task):
            return None
        waiting_session_id = task.get("waitingSessionId")
        if waiting_session_id and waiting_session_id != session_id:
            return None
        return task

    def _recovery_work_scope(self, session: dict[str, Any]) -> dict[str, str]:
        source_round: dict[str, Any] = next(
            (
                item
                for item in session.get("collaborationRounds", [])
                if item.get("roundId") == session.get("activeRoundId")
            ),
            {},
        )
        scope = source_round.get("workScope")
        if scope is None:
            # Historical links cannot establish execution ownership.
            if any(
                not task.get("isRoutine")
                for task in self.ctx.task_store.list_tasks_for_session(session["id"])
            ):
                raise CollaborationError(
                    "work_scope_required",
                    "This legacy thread has no recorded work scope. Restart from the task to establish task ownership.",
                )
            return {"kind": "thread"}
        if scope == {"kind": "thread"}:
            return {"kind": "thread"}
        if not (
            isinstance(scope, dict)
            and scope.get("kind") == "task"
            and isinstance(scope.get("taskId"), str)
            and scope["taskId"]
        ):
            raise CollaborationError(
                "work_scope_invalid",
                "The source round has an unsupported work scope.",
            )
        try:
            task = self.ctx.task_store.get_task(scope["taskId"])
        except KeyError:
            task = None
        if not task or task.get("deletedAt") or task.get("isRoutine"):
            raise CollaborationError(
                "task_unavailable",
                "The source task is unavailable for recovery.",
            )
        return {"kind": "task", "taskId": scope["taskId"]}

    def _assert_addressed_agents_on_node(
        self,
        raw_assignments: list[dict[str, Any]],
        room: list[str],
        required_node_id: str,
        daemon_nodes: list[dict[str, Any]],
    ) -> None:
        """An agent may only be mentioned into a thread from its own computer.

        Generic placement resolution reports this as `workspace_unavailable`,
        which reads as a transient runtime problem. A mention that names an
        agent living on another computer is a permanent, explainable mistake, so
        it gets its own code for the composer to render.
        """
        newcomers = [
            item["agentId"]
            for item in raw_assignments
            if isinstance(item, dict)
            and isinstance(item.get("agentId"), str)
            and item["agentId"] not in set(room)
        ]
        if not newcomers:
            return
        nodes_by_id = {node["id"]: node for node in daemon_nodes}
        required_computer_id = computer_id(
            nodes_by_id.get(required_node_id) or {"id": required_node_id}
        )
        for agent_id in newcomers:
            agent = {**(self.ctx.agent_store.get_agent(agent_id) or {}), "id": agent_id}
            if required_computer_id in agent_computer_ids(
                agent,
                placement_store=self.ctx.agent_placement_store,
                nodes_by_id=nodes_by_id,
            ):
                continue
            name = agent.get("displayName") or agent_id
            raise CollaborationError(
                "agent_not_on_thread_node",
                f"{name} does not run on this thread's computer.",
                status=400,
            )

    def _admit_addressed_agents(
        self,
        session: dict[str, Any],
        assignments: list[dict[str, Any]],
        actor: Actor,
    ) -> dict[str, Any]:
        """Grow the room to include agents this round addressed into it.

        Admission happens after dispatch resolves, so an agent that could not
        actually take the round never becomes a participant.
        """
        session_id = session.get("id")
        if not isinstance(session_id, str) or not session_id:
            return session
        room = set(_room_agent_ids(session))
        newcomers = [
            assignment["agentId"]
            for assignment in assignments
            if isinstance(assignment.get("agentId"), str)
            and assignment["agentId"] not in room
        ]
        if not newcomers:
            return session
        return SessionController(self.ctx.session_store).record_participants_joined(
            session_id, newcomers, actor["userId"]
        )

    def _session_for_actor(
        self, session_id: str | None, actor: Actor
    ) -> dict[str, Any] | None:
        if not session_id:
            return None
        try:
            session = self.ctx.session_store.get_session(session_id)
        except KeyError as error:
            raise CollaborationError("thread_not_found", status=404) from error
        if not session.get("id"):
            raise CollaborationError("thread_not_found", status=404)
        if (
            not actor["isAdmin"]
            and session.get("ownerUserId") != actor["userId"]
        ):
            raise CollaborationError("thread_forbidden", status=403)
        return session

    def _backfill_runtime_affinity(
        self, session: dict[str, Any] | None
    ) -> dict[str, Any] | None:
        nodes = self.ctx.registry.monitor_nodes()
        return persist_legacy_session_computer_id(
            session,
            session_store=self.ctx.session_store,
            placement_store=self.ctx.agent_placement_store,
            nodes={node["id"]: node for node in nodes},
            daemon_store=self.ctx.registry.daemon_store,
        )

    def _team_user_id(
        self, session: dict[str, Any] | None, actor: Actor
    ) -> str:
        if actor["isAdmin"] and session:
            return session.get("ownerUserId") or actor["userId"]
        return actor["userId"]

    def _round_team_id(
        self,
        thread_team_id: str | None,
        address_team_id: str | None,
        raw_assignments: list[dict[str, Any]] | None,
        *,
        retargetable: bool,
    ) -> str | None:
        """Which team, if any, runs this round.

        A thread is pinned to a computer, not to a roster: any agent or team on
        that computer shares its workspace. So a message may hand the round to
        another team, and a team thread may address an agent outside its team —
        that round simply runs without the team's contract. Recovery and the
        legacy assignment path keep the strict roster: a rerun or handoff
        repairs the team's own work.
        """
        if address_team_id:
            return address_team_id
        if not thread_team_id or not raw_assignments or not retargetable:
            return thread_team_id
        team = self.ctx.team_store.get_team(thread_team_id) or {}
        roster = set(team.get("memberAgentIds") or [])
        addressed = {
            item.get("agentId") for item in raw_assignments if isinstance(item, dict)
        }
        return thread_team_id if addressed <= roster else None

    def _team_for_round(
        self, team_id: str, session: dict[str, Any] | None, actor: Actor
    ) -> tuple[dict[str, Any], list[dict[str, Any]]]:
        return team_agents(
            team_id,
            self._team_user_id(session, actor),
            team_store=self.ctx.team_store,
            agent_store=self.ctx.agent_store,
        )

    @staticmethod
    def _compile_assignments(
        raw_assignments: list[dict[str, Any]],
        team_id: str | None,
        team_member_ids: set[str],
        team_snapshot: dict[str, Any] | None,
    ) -> list[dict[str, Any]]:
        assignments: list[dict[str, Any]] = []
        for item in raw_assignments:
            if (
                not isinstance(item, dict)
                or not isinstance(item.get("agentId"), str)
                or not item["agentId"]
            ):
                raise CollaborationError(
                    "assignment_invalid",
                    "Each participant requires agentId.",
                    status=400,
                )
            if team_id and item["agentId"] not in team_member_ids:
                raise CollaborationError(
                    "agent_forbidden",
                    "This thread belongs to a team; only its members can answer it.",
                )
            mode = _mode(item.get("mode"))
            role = _role(item.get("role"))
            coordinator = item.get("coordinator") is True or bool(
                team_snapshot
                and team_snapshot.get("collaborationStyle", LEAD_LED) == LEAD_LED
                and item["agentId"] == team_snapshot.get("leadAgentId")
                and not item.get("synthesizer")
            )
            # Always derived, never trusted from the caller: only this seam
            # knows who the team lead is, and a lead never leaves a writable
            # phase just because its default role is reviewer.
            phase = team_assignment_phase(role, mode, coordinator)
            assignments.append(
                {
                    # Minted here, never carried in: work results are keyed by
                    # it, so a shared id would let one report stand in for another.
                    "assignmentId": new_database_id(),
                    "agentId": item["agentId"],
                    **(
                        {"executorKind": item["executorKind"]}
                        if isinstance(item.get("executorKind"), str)
                        and item["executorKind"]
                        else {}
                    ),
                    "mode": mode,
                    "phase": phase,
                    **{key: item[key] for key in ("required", "acceptanceCriteria", "expectedOutputs") if key in item},
                    **({"role": role} if role else {}),
                    **(
                        {"brief": item["brief"].strip()[:ASSIGNMENT_BRIEF_MAX_CHARS]}
                        if isinstance(item.get("brief"), str) and item["brief"].strip()
                        else {}
                    ),
                    **({"coordinator": True} if coordinator else {}),
                    **(
                        {"synthesizer": True} if item.get("synthesizer") is True else {}
                    ),
                    **({"teamSnapshot": team_snapshot} if team_snapshot else {}),
                }
            )
        return assignments


# What a caller may say about a participant it names. Identity (`assignmentId`)
# and authority (`coordinator`, `synthesizer`, `required`, acceptance
# criteria, expected outputs, team snapshot) come from the conductor and the
# team's own configuration, never from the request.
CLIENT_ASSIGNMENT_FIELDS = ("agentId", "mode", "role", "brief")


def _client_assignments(
    raw_assignments: list[Any] | None,
) -> list[Any] | None:
    if raw_assignments is None:
        return None
    return [
        {key: item[key] for key in CLIENT_ASSIGNMENT_FIELDS if key in item}
        if isinstance(item, dict)
        else item
        for item in raw_assignments
    ]


def _scoped_idempotency_key(
    actor_user_id: str, session_id: str | None, caller_key: str
) -> str:
    resource = session_id or "new-thread"
    digest = hashlib.sha256(
        f"{actor_user_id}\0{resource}\0{caller_key}".encode()
    ).hexdigest()
    return f"collaboration:{digest}"


def _request_fingerprint(intent: _PreparedRound) -> str:
    payload = asdict(intent)
    payload.pop("idempotency_key", None)
    # Unset style is omitted so fingerprints recorded before styles existed
    # still match a retry of the same request.
    if payload.get("style") is None:
        payload.pop("style", None)
    if payload.get("question_id") is None:
        payload.pop("question_id", None)
    if payload.get("project_setup") is None:
        payload.pop("project_setup", None)
    else:
        # Draft identity fences result writes; it is not part of the owner's
        # request and must not make an otherwise identical retry conflict.
        payload["project_setup"].pop("draftId", None)
    # Addressing the same text to a different set of agents is a different
    # request; addressing the same set in a different order is not.
    address = payload.get("address")
    if isinstance(address, dict) and isinstance(address.get("agentIds"), list):
        payload["address"] = {**address, "agentIds": sorted(address["agentIds"])}
    assignments = payload.get("raw_assignments")
    if isinstance(assignments, list):
        payload["raw_assignments"] = sorted(
            assignments,
            key=lambda item: str(item.get("agentId"))
            if isinstance(item, dict)
            else "",
        )
    encoded = json.dumps(
        payload,
        sort_keys=True,
        separators=(",", ":"),
        ensure_ascii=True,
    ).encode()
    return hashlib.sha256(encoded).hexdigest()


def _room_agent_ids(session: dict[str, Any]) -> list[str]:
    """Every agent currently in the thread's room.

    The roster is authoritative once a thread has one. Threads created before
    the roster existed replay with only their owner agent, which is exactly the
    room they had.
    """
    roster = [
        agent_id
        for agent_id in session.get("participantAgentIds") or []
        if isinstance(agent_id, str) and agent_id
    ]
    if roster:
        return roster
    owner_agent_id = session.get("ownerAgentId")
    return [owner_agent_id] if isinstance(owner_agent_id, str) and owner_agent_id else []


def _mode(value: Any) -> str:
    return value if value in VALID_MODES else "action"


def _role(value: Any) -> str | None:
    return value if value in VALID_ROLES else None


def _resumable_wait(task: dict[str, Any]) -> bool:
    return (
        not task.get("deletedAt")
        and not task.get("isRoutine")
        and task.get("status") == "waiting_for_human"
    )


def _purpose_for_mode(mode: Any) -> str:
    if mode == "ask":
        return "discuss"
    if mode == "review":
        return "review"
    return "accomplish"


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


def _prepare_message(intent: MessageIntent) -> _PreparedRound:
    purpose_modes = {
        "accomplish": "action",
        "discuss": "ask",
        "review": "review",
    }
    addressed_ids = list(dict.fromkeys(intent.address_agent_ids))
    raw_assignments = (
        [
            {"agentId": agent_id, "mode": purpose_modes[intent.purpose]}
            for agent_id in addressed_ids
        ]
        if addressed_ids
        else None
    )
    address = (
        {"kind": "members", "agentIds": addressed_ids}
        if addressed_ids
        else {"kind": "team", "teamId": intent.address_team_id}
        if intent.address_team_id
        else {"kind": "room"}
    )
    return _PreparedRound(
        task_goal=intent.text,
        session_id=intent.thread_id,
        raw_assignments=raw_assignments,
        mode=purpose_modes[intent.purpose],
        requested_team_id=None,
        address_team_id=intent.address_team_id,
        requested_project_id=None,
        requested_node_id=None,
        idempotency_key=intent.idempotency_key or intent.user_message_id,
        user_message_id=intent.user_message_id,
        decision=None,
        source="message",
        purpose=intent.purpose,
        address=address,
        style=intent.style,
        question_id=intent.question_id,
    )


def _prepare_recovery(intent: RecoveryIntent) -> _PreparedRound:
    mode = _mode(intent.mode)
    return _PreparedRound(
        task_goal="",
        session_id=intent.thread_id,
        raw_assignments=[{"agentId": intent.target_agent_id, "mode": mode}],
        mode=mode,
        requested_team_id=None,
        address_team_id=None,
        requested_project_id=None,
        requested_node_id=None,
        idempotency_key=intent.idempotency_key,
        user_message_id=None,
        decision={
            "kind": intent.kind,
            "targetAgentId": intent.target_agent_id,
            **({"note": intent.note} if intent.note else {}),
            **({"resume": True} if intent.resume else {}),
        },
        source="recovery",
        purpose=_purpose_for_mode(mode),
        address={
            "kind": "members",
            "agentIds": [intent.target_agent_id],
        },
    )


def _prepare_run(intent: RunIntent) -> _PreparedRound:
    raw_assignments = _client_assignments(intent.raw_assignments)
    addressed = [
        item.get("agentId")
        for item in (raw_assignments or [])
        if isinstance(item, dict) and isinstance(item.get("agentId"), str)
    ]
    return _PreparedRound(
        task_goal=intent.task_goal,
        session_id=intent.session_id,
        raw_assignments=raw_assignments,
        mode=_mode(intent.mode),
        requested_team_id=intent.requested_team_id,
        address_team_id=None,
        requested_project_id=intent.requested_project_id,
        requested_node_id=intent.requested_node_id,
        idempotency_key=intent.idempotency_key,
        user_message_id=intent.user_message_id,
        decision=intent.decision,
        source=intent.source,
        style=intent.style,
        project_setup=intent.project_setup,
        purpose=_purpose_for_mode(intent.mode),
        address=(
            {"kind": "members", "agentIds": addressed}
            if addressed
            else {"kind": "room"}
        ),
    )


def _round_task_goal(
    intent: _PreparedRound, session: dict[str, Any] | None
) -> str:
    """A recovery reruns the thread's latest ask; anything else brings its own."""
    task_goal = (
        latest_user_turn_text(session)
        if intent.source == "recovery" and session
        else intent.task_goal
    )
    if not isinstance(task_goal, str) or not task_goal:
        raise CollaborationError("task_goal_required", status=400)
    return task_goal


def _round_scope_ids(
    intent: _PreparedRound, session: dict[str, Any] | None
) -> tuple[str | None, str | None]:
    """The thread's team and project; a request may not contradict them."""
    session_team_id = session.get("teamId") if session else None
    if (
        session
        and intent.requested_team_id
        and intent.requested_team_id != session_team_id
    ):
        raise CollaborationError(
            "team_mismatch",
            "teamId does not match this thread's team.",
            status=400,
        )
    team_id = session_team_id or intent.requested_team_id
    session_project_id = session.get("projectId") if session else None
    if (
        session
        and intent.requested_project_id
        and intent.requested_project_id != session_project_id
    ):
        raise CollaborationError(
            "project_mismatch",
            "projectId does not match this thread's project.",
            status=400,
        )
    project_id = session_project_id or intent.requested_project_id
    # A project thread is the project's room: team work enters through a task.
    if (team_id or intent.address_team_id) and project_id:
        raise CollaborationError("project_team_conflict", status=400)
    return team_id, project_id


def _is_recovery_decision(decision: dict[str, Any] | None) -> bool:
    return isinstance(decision, dict) and decision.get("kind") in (
        "rerun",
        "handoff",
    )


def _assert_style_allowed(intent: _PreparedRound, round_team_id: str | None) -> None:
    if intent.style is not None and (
        intent.purpose != "accomplish"
        or intent.address.get("kind") == "members"
        or not round_team_id
    ):
        raise CollaborationError(
            "style_requires_team",
            "Collaboration style applies to team work requests only.",
            status=400,
        )


def _project_selected_ids(
    raw_assignments: list[dict[str, Any]] | None,
) -> list[str] | None:
    """The agents a project round names, or None when it names nobody."""
    if raw_assignments is None:
        return None
    if not raw_assignments or any(
        not isinstance(item, dict)
        or not isinstance(item.get("agentId"), str)
        or not item["agentId"].strip()
        for item in raw_assignments
    ):
        raise CollaborationError("project_assignment_invalid", status=400)
    return [item["agentId"].strip() for item in raw_assignments]


def _room_assignments(session: dict[str, Any], mode: str) -> list[dict[str, Any]]:
    """A bare message goes to the whole room.

    Every agent the thread has accumulated, not just the one it started with.
    """
    room = _room_agent_ids(session)
    if not room:
        raise CollaborationError(
            "participants_required",
            "The thread has no addressable room participant.",
            status=400,
        )
    return [{"agentId": agent_id, "mode": mode} for agent_id in room]


TEAM_DEFAULT_ASSIGNMENT_FIELDS = (
    "role",
    "brief",
    "required",
    "acceptanceCriteria",
    "expectedOutputs",
)


def _with_member_defaults(
    raw_assignments: list[Any], member_assignments: list[dict[str, Any]]
) -> list[Any]:
    """Fill each named member's team brief and role under explicit overrides."""
    member_defaults = {
        item["agentId"]: {
            key: item[key] for key in TEAM_DEFAULT_ASSIGNMENT_FIELDS if key in item
        }
        for item in member_assignments
        if not item.get("synthesizer") or item.get("coordinator")
    }
    return [
        {**member_defaults.get(item.get("agentId"), {}), **item}
        if isinstance(item, dict) and isinstance(item.get("agentId"), str)
        else item
        for item in raw_assignments
    ]


def _lead_led_order(
    raw_assignments: list[Any],
    member_assignments: list[dict[str, Any]],
    lead_agent_id: str | None,
) -> list[Any]:
    """Move an addressed lead first and give it the closing synthesis turn."""
    lead_index = next(
        (
            index
            for index, item in enumerate(raw_assignments)
            if isinstance(item, dict)
            and item.get("agentId") == lead_agent_id
            and _mode(item.get("mode")) == "action"
            and not item.get("synthesizer")
        ),
        None,
    )
    if lead_index is None:
        return raw_assignments
    ordered = [
        raw_assignments[lead_index],
        *raw_assignments[:lead_index],
        *raw_assignments[lead_index + 1:],
    ]
    if any(
        isinstance(item, dict) and item.get("synthesizer") is True
        for item in ordered
    ):
        return ordered
    synthesis = next(
        (item for item in member_assignments if item.get("synthesizer")),
        None,
    )
    return [*ordered, synthesis] if synthesis else ordered


def _assert_same_runtime(
    intent: _PreparedRound,
    session: dict[str, Any] | None,
    session_node_id: str | None,
) -> None:
    """A thread keeps the computer it runs on; naming another is refused."""
    requested_original_runtime = bool(
        session
        and session.get("managedNodeId")
        and intent.requested_node_id == session.get("daemonNodeId")
    )
    if (
        session_node_id
        and intent.requested_node_id
        and intent.requested_node_id != session_node_id
        and not requested_original_runtime
    ):
        raise CollaborationError(
            "workspace_unavailable",
            "This thread already runs on another computer.",
        )


def _with_work_contract(
    team_snapshot: dict[str, Any] | None,
    intent: _PreparedRound,
    is_recovery: bool,
    assignment_count: int,
) -> dict[str, Any] | None:
    """New team work must use validated delegation even without custom roles.

    Single-member recovery retains the admitted legacy compatibility path.
    """
    if (
        team_snapshot
        and intent.purpose == "accomplish"
        and not is_recovery
        and assignment_count > 1
    ):
        return {**team_snapshot, "workContractVersion": 1}
    return team_snapshot


def _execution_revision(task: dict[str, Any]) -> Any:
    return (task.get("executionOwner") or {}).get("revision", 0)


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
