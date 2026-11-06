"""Who takes a round: the project crew, a team, or the thread's room."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from ..core.human_waits import QUESTION_ID_PREFIX
from ..projects.runtime import (
    ProjectDispatchError,
    project_member_ids,
    project_thread_assignments,
    project_task_assignment_error,
    project_runtime_snapshot,
)
from ..teams.dispatch import (
    team_agents,
    team_member_assignments,
    team_runtime_snapshot,
)
from ..security.actor import Actor
from .errors import CollaborationError
from .intake import _PreparedRound, _mode
from .state import ConductorState
from .styles import LEAD_LED, resolve_collaboration_style


@dataclass(frozen=True)
class _RoundRoster:
    """The participants a round resolves to, before placement."""

    raw_assignments: list[dict[str, Any]]
    team_member_ids: set[str] = field(default_factory=set)
    team_snapshot: dict[str, Any] | None = None
    project: dict[str, Any] | None = None
    project_snapshot: dict[str, Any] | None = None


class RosterMixin(ConductorState):
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
