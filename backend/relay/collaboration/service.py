from __future__ import annotations

import hashlib
import json
from dataclasses import asdict, dataclass, replace
from typing import Any

from ..core.computer_identity import computer_id
from ..core.ids import new_database_id, new_relay_id
from ..services.agent_routing import (
    AgentRoutingError,
    persist_legacy_session_computer_id,
    resolve_agent_assignments,
    resolve_session_daemon_node_id,
)
from ..services.project_runtime import (
    ProjectDispatchError,
    project_member_assignments,
    project_runtime_node,
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
    CollaborationIdempotencyError,
    MessageIntent,
    RecoveryIntent,
    RunIntent,
)

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
    requested_project_id: str | None
    requested_node_id: str | None
    idempotency_key: str | None
    user_message_id: str | None
    decision: dict[str, Any] | None
    source: str
    purpose: str
    address: dict[str, Any]


class CollaborationConductor:
    """Turn semantic collaboration intent into one durable, auditable round.

    Daemon delivery remains behind ``ctx.backend`` during the compatibility
    migration. Callers no longer need to resolve a room into assignments.
    """

    def __init__(self, ctx: Any):
        self.ctx = ctx

    async def submit(
        self, intent: MessageIntent | RecoveryIntent | RunIntent, actor: dict[str, Any]
    ) -> dict[str, Any]:
        prepared = self._prepare(intent)
        fingerprint = _request_fingerprint(prepared)
        if prepared.idempotency_key:
            prepared = replace(
                prepared,
                idempotency_key=_scoped_idempotency_key(
                    actor["employeeId"],
                    prepared.session_id,
                    prepared.idempotency_key,
                ),
            )
        try:
            if prepared.idempotency_key:
                existing = self.ctx.backend.idempotent_run(
                    prepared.idempotency_key,
                    actor["employeeId"],
                    actor_is_admin=actor["isAdmin"],
                    expected_fingerprint=fingerprint,
                )
                if existing:
                    return existing
            elif prepared.session_id:
                existing = self.ctx.backend.idempotent_session_run(
                    prepared.session_id,
                    actor["employeeId"],
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
                else {"kind": "room"}
            )
            return _PreparedRound(
                task_goal=intent.text,
                session_id=intent.thread_id,
                raw_assignments=raw_assignments,
                mode=purpose_modes[intent.purpose],
                requested_team_id=None,
                requested_project_id=None,
                requested_node_id=None,
                idempotency_key=intent.idempotency_key or intent.user_message_id,
                user_message_id=intent.user_message_id,
                decision=None,
                source="message",
                purpose=intent.purpose,
                address=address,
            )
        if isinstance(intent, RecoveryIntent):
            mode = _mode(intent.mode)
            return _PreparedRound(
                task_goal="",
                session_id=intent.thread_id,
                raw_assignments=[{"agentId": intent.target_agent_id, "mode": mode}],
                mode=mode,
                requested_team_id=None,
                requested_project_id=None,
                requested_node_id=None,
                idempotency_key=intent.idempotency_key,
                user_message_id=None,
                decision={
                    "kind": intent.kind,
                    "targetAgentId": intent.target_agent_id,
                    **({"note": intent.note} if intent.note else {}),
                },
                source="recovery",
                purpose=_purpose_for_mode(mode),
                address={
                    "kind": "members",
                    "agentIds": [intent.target_agent_id],
                },
            )
        raw_assignments = intent.raw_assignments
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
            requested_project_id=intent.requested_project_id,
            requested_node_id=intent.requested_node_id,
            idempotency_key=intent.idempotency_key,
            user_message_id=intent.user_message_id,
            decision=intent.decision,
            source=intent.source,
            purpose=_purpose_for_mode(intent.mode),
            address=(
                {"kind": "members", "agentIds": addressed}
                if addressed
                else {"kind": "room"}
            ),
        )

    async def _submit_prepared(
        self,
        intent: _PreparedRound,
        actor: dict[str, Any],
        fingerprint: str,
    ) -> dict[str, Any]:
        session = self._session_for_actor(intent.session_id, actor)
        session = self._backfill_runtime_affinity(session)
        task_goal = (
            latest_user_turn_text(session)
            if intent.source == "recovery" and session
            else intent.task_goal
        )
        if not isinstance(task_goal, str) or not task_goal:
            raise CollaborationError("task_goal_required", status=400)
        raw_assignments = intent.raw_assignments
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
        if team_id and project_id:
            raise CollaborationError("project_team_conflict", status=400)
        team_member_ids: set[str] = set()
        team_snapshot: dict[str, Any] | None = None
        team: dict[str, Any] | None = None
        is_recovery = isinstance(intent.decision, dict) and intent.decision.get(
            "kind"
        ) in ("rerun", "handoff")
        project: dict[str, Any] | None = None
        project_snapshot: dict[str, Any] | None = None
        if project_id:
            project = self.ctx.project_store.get_project(project_id)
            if not project or project.get("archivedAt"):
                raise CollaborationError("project_not_found", status=404)
            expected_owner = (
                session.get("ownerEmployeeId") if session else actor["employeeId"]
            )
            if project.get("ownerEmployeeId") != expected_owner:
                raise CollaborationError("project_forbidden", status=403)
            if not project.get("enabled", True):
                raise CollaborationError("project_disabled")
            project_snapshot = project_runtime_snapshot(project)
            if raw_assignments is not None and (
                not raw_assignments
                or any(
                    not isinstance(item, dict)
                    or not isinstance(item.get("agentId"), str)
                    or not item["agentId"].strip()
                    for item in raw_assignments
                )
            ):
                raise CollaborationError("project_assignment_invalid", status=400)
            selected_ids = (
                [item["agentId"].strip() for item in raw_assignments]
                if raw_assignments is not None
                else None
            )
            try:
                raw_assignments = project_member_assignments(
                    project,
                    mode=intent.mode,
                    selected_agent_ids=selected_ids,
                    snapshot=project_snapshot,
                )
            except ProjectDispatchError as error:
                raise CollaborationError(error.code, status=400) from error
        elif team_id and not raw_assignments:
            team, members = self._team_for_round(team_id, session, actor)
            team_member_ids = {agent["id"] for agent in members}
            team_snapshot = team_runtime_snapshot(team, members)
            raw_assignments = team_member_assignments(
                members, mode=intent.mode, team=team
            )
        elif team_id and raw_assignments:
            if is_recovery:
                # Recovery deliberately skips `team_agents`. A rerun or handoff
                # is how a stuck thread gets rescued, so it must still work
                # after the team was disabled or a sibling member broke;
                # requiring the whole roster to be healthy would strand the
                # thread. Ownership and membership are still enforced, and the
                # target agent's own liveness is checked by
                # `resolve_agent_assignments` below.
                team = self.ctx.team_store.get_team(team_id)
                if not team or team.get("deletedAt"):
                    raise CollaborationError("team_not_found")
                expected_owner = self._team_employee_id(session, actor)
                if team.get("ownerEmployeeId") != expected_owner:
                    raise CollaborationError("team_forbidden")
                team_member_ids = set(team.get("memberAgentIds") or [])
                members = [
                    self.ctx.agent_store.get_agent(agent_id)
                    for agent_id in team.get("memberAgentIds") or []
                ]
                members = [member for member in members if member]
            else:
                team, members = self._team_for_round(team_id, session, actor)
                team_member_ids = {agent["id"] for agent in members}
            team_snapshot = team_runtime_snapshot(team, members)
            # Addressing chooses participants, not their specialization. Keep
            # caller ordering and explicit overrides, but fill in team briefs
            # and roles without turning an addressed lead into a room synthesizer.
            member_defaults = {
                item["agentId"]: {
                    key: item[key] for key in ("role", "brief") if key in item
                }
                for item in team_member_assignments(members, team=team)
            }
            raw_assignments = [
                {**member_defaults.get(item.get("agentId"), {}), **item}
                if isinstance(item, dict) and isinstance(item.get("agentId"), str)
                else item
                for item in raw_assignments
            ]
        elif session and not raw_assignments:
            # A bare message goes to the whole room: every agent the thread has
            # accumulated, not just the one it started with.
            room = _room_agent_ids(session)
            if not room:
                raise CollaborationError(
                    "participants_required",
                    "The thread has no addressable room participant.",
                    status=400,
                )
            raw_assignments = [
                {"agentId": agent_id, "mode": intent.mode} for agent_id in room
            ]
        if not raw_assignments:
            raise CollaborationError(
                "participants_required",
                "At least one participant is required.",
                status=400,
            )

        daemon_nodes = self.ctx.registry.monitor_nodes()
        session_node_id = resolve_session_daemon_node_id(session, daemon_nodes)
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
        project_node = project_runtime_node(project, daemon_nodes) if project else None
        if project and project_node is None:
            raise CollaborationError("project_computer_offline")
        required_node_id = (
            session_node_id
            or (project_node or {}).get("id")
            or intent.requested_node_id
        )
        if intent.source == "message" and session and required_node_id:
            self._assert_addressed_agents_on_node(
                raw_assignments,
                _room_agent_ids(session),
                required_node_id,
                daemon_nodes,
            )
        assignments = self._compile_assignments(
            raw_assignments, team_id, team_member_ids, team_snapshot
        )
        resolved = resolve_agent_assignments(
            assignments,
            employee_id=actor["employeeId"],
            is_admin=actor["isAdmin"],
            agent_store=self.ctx.agent_store,
            placement_store=self.ctx.agent_placement_store,
            daemon_nodes=daemon_nodes,
            session=session,
            required_node_id=required_node_id,
            daemon_store=self.ctx.registry.daemon_store,
            session_store=self.ctx.session_store,
        )
        resolved = compile_assignment_work_graph(
            resolved,
            purpose=intent.purpose,
            team_snapshot=team_snapshot,
        )
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
        if session and intent.decision and intent.decision.get("kind") == "handoff":
            manifest["handoffContext"] = capture_handoff_context(
                session, resolved[0], intent.decision.get("note"), self.ctx.session_store
            )
            manifest["handoffContext"]["decisionId"] = f"dec_{round_id}"
        parsed: dict[str, Any] = {
            "taskGoal": task_goal,
            "assignments": resolved,
            "actorEmployeeId": actor["employeeId"],
            "actorIsAdmin": actor["isAdmin"],
            "agentFirst": True,
            "daemonNodeId": required_node_id or resolved[0]["daemonNodeId"],
            "collaboration": {"manifest": manifest},
        }
        if intent.session_id:
            parsed["sessionId"] = intent.session_id
        if intent.user_message_id:
            parsed["userMessageId"] = intent.user_message_id
        parsed["idempotencyFingerprint"] = fingerprint
        if intent.idempotency_key:
            parsed["idempotencyKey"] = intent.idempotency_key
        if team_id:
            parsed["teamId"] = team_id
        if project_snapshot:
            parsed.update(
                {
                    "projectId": project_snapshot["projectId"],
                    "workspaceLayout": "project",
                    "workspaceSubpath": project_snapshot["workspaceSubpath"],
                }
            )
        if intent.decision:
            parsed["decision"] = _validated_decision(intent.decision, resolved[0])
        dispatched = await self.ctx.backend.run(resolved[0]["daemonNodeId"], parsed)
        return self._admit_addressed_agents(dispatched, resolved, actor)

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
        required_node = nodes_by_id.get(required_node_id) or {}
        required_computer_id = computer_id(required_node) if required_node else None
        managed_node_id = required_node.get("managedNodeId")
        allowed_node_ids = {required_node_id} | {
            node["id"]
            for node in daemon_nodes
            if managed_node_id and node.get("managedNodeId") == managed_node_id
        }
        for agent_id in newcomers:
            placements = self.ctx.agent_placement_store.list_placements(
                agent_id=agent_id
            )
            if any(
                placement.get("desiredState") != "removed"
                and (
                    placement.get("computerId") == required_computer_id
                    or (
                        not placement.get("computerId")
                        and placement.get("daemonNodeId") in allowed_node_ids
                    )
                )
                for placement in placements
            ):
                continue
            agent = self.ctx.agent_store.get_agent(agent_id)
            name = (agent or {}).get("displayName") or agent_id
            raise CollaborationError(
                "agent_not_on_thread_node",
                f"{name} does not run on this thread's computer.",
                status=400,
            )

    def _admit_addressed_agents(
        self,
        session: dict[str, Any],
        assignments: list[dict[str, Any]],
        actor: dict[str, Any],
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
            session_id, newcomers, actor["employeeId"]
        )

    def _session_for_actor(
        self, session_id: str | None, actor: dict[str, Any]
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
            and session.get("ownerEmployeeId") != actor["employeeId"]
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

    def _team_employee_id(
        self, session: dict[str, Any] | None, actor: dict[str, Any]
    ) -> str:
        if actor["isAdmin"] and session:
            return session.get("ownerEmployeeId") or actor["employeeId"]
        return actor["employeeId"]

    def _team_for_round(
        self, team_id: str, session: dict[str, Any] | None, actor: dict[str, Any]
    ) -> tuple[dict[str, Any], list[dict[str, Any]]]:
        return team_agents(
            team_id,
            self._team_employee_id(session, actor),
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
                team_snapshot and item["agentId"] == team_snapshot.get("leadAgentId")
            )
            # Always derived, never trusted from the caller: only this seam
            # knows who the team lead is, and a lead never leaves a writable
            # phase just because its default role is reviewer.
            phase = team_assignment_phase(role, mode, coordinator)
            assignments.append(
                {
                    "assignmentId": item.get("assignmentId") or new_database_id(),
                    "agentId": item["agentId"],
                    **(
                        {"executorKind": item["executorKind"]}
                        if isinstance(item.get("executorKind"), str)
                        and item["executorKind"]
                        else {}
                    ),
                    "mode": mode,
                    "phase": phase,
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


def _scoped_idempotency_key(
    actor_employee_id: str, session_id: str | None, caller_key: str
) -> str:
    resource = session_id or "new-thread"
    digest = hashlib.sha256(
        f"{actor_employee_id}\0{resource}\0{caller_key}".encode()
    ).hexdigest()
    return f"collaboration:{digest}"


def _request_fingerprint(intent: _PreparedRound) -> str:
    payload = asdict(intent)
    payload.pop("idempotency_key", None)
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


def _purpose_for_mode(mode: Any) -> str:
    if mode == "ask":
        return "discuss"
    if mode == "review":
        return "review"
    return "accomplish"


def create_round_manifest(
    *,
    source: str,
    purpose: str,
    address: dict[str, Any],
    assignments: list[dict[str, Any]],
    team_snapshot: dict[str, Any] | None,
    project_snapshot: dict[str, Any] | None = None,
    collaboration_id: str | None = None,
    round_id: str | None = None,
) -> dict[str, Any]:
    strategy = (
        "direct"
        if address.get("kind") == "members" and len(assignments) == 1
        else "room"
        if purpose == "discuss"
        else "review"
        if purpose == "review"
        else "coordinate"
    )
    compiled_assignments = compile_assignment_work_graph(
        assignments,
        purpose=purpose,
        team_snapshot=team_snapshot,
    )
    work_items = [
        {
            "workItemId": assignment["workItemId"],
            "assignmentId": assignment["assignmentId"],
            "ownerAgentId": assignment["workOwnerAgentId"],
            **(
                {"delegationAuthority": assignment["delegationAuthority"]}
                if assignment.get("delegationAuthority")
                else {}
            ),
            "kind": assignment["workKind"],
            "objective": assignment["workObjective"],
            "dependsOnWorkItemIds": assignment["dependsOnWorkItemIds"],
            "required": True,
        }
        for assignment in compiled_assignments
    ]
    completion_kind = "synthesize" if strategy in ("room", "review") else "all_required"
    result_owner = _result_owner_work_item(compiled_assignments)
    return {
        "contract": {
            "name": "relay.collaboration.round",
            "version": 2,
        },
        "collaborationId": collaboration_id or new_relay_id("col"),
        "roundId": round_id or new_relay_id("round"),
        "source": source,
        "purpose": purpose,
        "strategy": strategy,
        "address": address,
        **({"teamSnapshot": team_snapshot} if team_snapshot else {}),
        **({"projectSnapshot": project_snapshot} if project_snapshot else {}),
        "assignments": [
            {
                key: assignment[key]
                for key in (
                    "assignmentId",
                    "agentId",
                    "mode",
                    "phase",
                    "role",
                    "brief",
                    "coordinator",
                    "synthesizer",
                )
                if assignment.get(key) is not None
            }
            for assignment in compiled_assignments
        ],
        "completionPolicy": (
            "synthesize" if strategy in ("room", "review") else "assigned_work"
        ),
        "workGraph": {
            "contract": {
                "name": "relay.collaboration.work-graph",
                "version": 1,
            },
            "items": work_items,
            "completion": {
                "kind": completion_kind,
                **({"resultOwnerWorkItemId": result_owner} if result_owner else {}),
            },
            "delegationPolicy": {
                "authority": "conductor",
                "policy": "sequential-role-delegation-v1",
            },
        },
    }


def compile_assignment_work_graph(
    assignments: list[dict[str, Any]],
    *,
    purpose: str,
    team_snapshot: dict[str, Any] | None,
) -> list[dict[str, Any]]:
    """Attach the conductor-owned delegated-subtask contract to assignments.

    Delivery may remain sequential, but the immutable graph records the actual
    ownership and prerequisites independently of that transport choice.

    Compiling is idempotent by construction, because the conductor compiles for
    dispatch and ``create_round_manifest`` compiles again for the record. Taking
    the already-compiled roster straight back keeps that second pass from
    depending on the objective decoration being re-entrant.
    """
    if assignments and all(_is_compiled_work_assignment(assignment) for assignment in assignments):
        return [dict(assignment) for assignment in assignments]
    work_item_ids = [assignment["assignmentId"] for assignment in assignments]
    compiled: list[dict[str, Any]] = []
    for index, assignment in enumerate(assignments):
        work_item_id = assignment["assignmentId"]
        synthesizer = assignment.get("synthesizer") is True
        if synthesizer:
            dependencies = work_item_ids[:index]
        elif purpose in ("discuss", "review"):
            dependencies = []
        else:
            # The current delivery adapter is sequential. Recording that chain
            # makes the graph truthful today while leaving the public contract
            # ready for a later dependency-aware parallel reconciler.
            dependencies = work_item_ids[:index]
        owner_agent_id = _work_owner_agent_id(assignment)
        objective = assignment.get("workObjective") or _work_objective(
            assignment,
            index=index,
            total=len(assignments),
            dependencies=dependencies,
        )
        compiled.append(
            {
                **assignment,
                "brief": objective,
                "workItemId": work_item_id,
                "workOwnerAgentId": owner_agent_id,
                "workKind": _work_kind(assignment),
                "workObjective": objective,
                "dependsOnWorkItemIds": dependencies,
                "delegationAuthority": "conductor",
            }
        )
    return compiled


def _is_compiled_work_assignment(assignment: dict[str, Any]) -> bool:
    return all(
        assignment.get(field) is not None
        for field in (
            "workItemId",
            "workOwnerAgentId",
            "workKind",
            "workObjective",
            "dependsOnWorkItemIds",
        )
    )


def _work_owner_agent_id(assignment: dict[str, Any]) -> str:
    agent_id = assignment.get("agentId")
    if isinstance(agent_id, str) and agent_id:
        return agent_id
    executor = assignment.get("executorKind") or assignment.get("agent") or "unknown"
    return f"legacy-executor:{executor}"


def _work_kind(assignment: dict[str, Any]) -> str:
    if assignment.get("synthesizer") is True:
        return "synthesis"
    mode = assignment.get("mode") or "action"
    role = assignment.get("role")
    if mode == "ask":
        return "discussion"
    if mode == "review":
        return "review"
    if assignment.get("coordinator") is True:
        return "coordination"
    if role == "reviewer":
        return "review"
    if role == "tester":
        return "verification"
    if role == "planner":
        return "planning"
    if role == "fixer":
        return "repair"
    return "implementation"


def _work_objective(
    assignment: dict[str, Any],
    *,
    index: int,
    total: int,
    dependencies: list[str],
) -> str:
    brief = assignment.get("brief")
    if isinstance(brief, str) and brief.strip():
        objective = brief.strip()
    else:
        objective = {
            "discussion": "Contribute to the team's discussion.",
            "review": "Review the accumulated team result.",
            "verification": "Verify the accumulated implementation.",
            "planning": "Plan the delegated team work.",
            "repair": "Repair confirmed defects in the accumulated work.",
            "coordination": "Coordinate the delegated team work.",
            "synthesis": "Synthesize the team's contributions into one result.",
            "implementation": "Implement a distinct part of the shared goal.",
        }[_work_kind(assignment)]
    if total <= 1 or assignment.get("coordinator") or assignment.get("synthesizer"):
        return objective
    if not dependencies:
        return (
            f"{objective} Own delegated work item {index + 1} of {total} as an "
            "independently eligible contribution; do not duplicate another item."
        )
    return (
        f"{objective} Own delegated work item {index + 1} of {total}; "
        "use predecessor results and do not duplicate another item."
    )


def _result_owner_work_item(assignments: list[dict[str, Any]]) -> str | None:
    synthesizers = [
        assignment
        for assignment in assignments
        if assignment.get("synthesizer") is True
    ]
    if synthesizers:
        return synthesizers[-1]["workItemId"]
    writable = [
        assignment
        for assignment in assignments
        if (assignment.get("mode") or "action") != "ask"
    ]
    owner = writable[-1] if writable else assignments[-1] if assignments else None
    return owner["workItemId"] if owner else None


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
    }
