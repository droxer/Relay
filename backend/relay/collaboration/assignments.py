"""Resolve a round's roster into placed assignments on one computer."""

from __future__ import annotations

from typing import Any

from ..core.computer_identity import computer_id
from ..core.ids import new_database_id
from ..agents.location import agent_computer_ids
from ..agents.routing import (
    persist_legacy_session_computer_id,
    resolve_agent_assignments,
    resolve_session_daemon_node_id,
)
from ..projects.runtime import project_runtime_node
from ..teams.dispatch import team_assignment_phase
from ..sessions.controller import SessionController
from ..security.actor import Actor
from .errors import CollaborationError
from .intake import _PreparedRound, _mode, _role
from .manifest import compile_assignment_work_graph
from .roster import _RoundRoster, _room_agent_ids
from .state import ConductorState
from .styles import LEAD_LED

ASSIGNMENT_BRIEF_MAX_CHARS = 4000


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


class AssignmentsMixin(ConductorState):
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
