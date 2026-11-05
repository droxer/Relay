from __future__ import annotations

from dataclasses import replace
from typing import Any

from ..agents.routing import AgentRoutingError
from ..teams.dispatch import TeamDispatchError
from .approval_round import ApprovalRoundMixin
from .assignments import AssignmentsMixin, _with_work_contract
from .errors import CollaborationError
from .intake import (
    _PreparedRound,
    _assert_style_allowed,
    _is_recovery_decision,
    _prepare_message,
    _prepare_recovery,
    _prepare_run,
    _request_fingerprint,
    _round_scope_ids,
    _round_task_goal,
    _scoped_idempotency_key,
)
from .models import (
    CollaborationIdempotencyError,
    MessageIntent,
    RecoveryIntent,
    RunIntent,
)
from .request import RoundRequestMixin
from .roster import RosterMixin, _room_agent_ids
from .task_scope import TaskScopeMixin
from ..security.actor import Actor


class CollaborationConductor(
    RosterMixin, AssignmentsMixin, TaskScopeMixin, RoundRequestMixin, ApprovalRoundMixin
):
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
                    actor_is_admin=False,
                    expected_fingerprint=fingerprint,
                )
                if existing:
                    return existing
            elif prepared.session_id:
                existing = self.ctx.backend.idempotent_session_run(
                    prepared.session_id,
                    actor["userId"],
                    actor_is_admin=False,
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
        if session and answered_task:
            resumed = self._approval_round(
                intent, actor, fingerprint, session=session, task=answered_task
            )
            if resumed is not None:
                resumed = self._with_images(intent, actor, session, resumed, self.ctx.registry.monitor_nodes())
                return await self.ctx.backend.run(resumed["daemonNodeId"], resumed)
        elif intent.approve:
            raise CollaborationError(
                "approval_not_awaited", "An approval names the wait it answers."
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
        parsed = self._with_images(intent, actor, session, parsed, daemon_nodes)
        dispatched = await self.ctx.backend.run(resolved[0]["daemonNodeId"], parsed)
        return self._admit_addressed_agents(dispatched, resolved, actor)

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
            session.get("ownerUserId") != actor["userId"]
        ):
            raise CollaborationError("thread_forbidden", status=403)
        return session

    def _with_images(
        self, intent: _PreparedRound, actor: Actor, session: dict[str, Any] | None,
        parsed: dict[str, Any], daemon_nodes: list[dict[str, Any]],
    ) -> dict[str, Any]:
        message_images = self.ctx.session_store.resolve_attachments(
            intent.attachment_ids, actor["userId"], intent.session_id
        )
        # A new runtime conversation and a handoff still need the most recent
        # visual context. Only explicitly attached images appear on this message.
        images = message_images
        if not images and session:
            images = next((event["attachments"] for event in reversed(session.get("events", []))
                           if event.get("type") in ("user.message", "session.created") and event.get("attachments")), [])
        if images:
            for assignment in parsed["assignments"]:
                node: dict[str, Any] = next((node for node in daemon_nodes if node["id"] == assignment["daemonNodeId"]), {})
                if "image-attachments" not in (node.get("capabilities") or []):
                    raise CollaborationError("image_client_update_required", "Update this Computer to send images.", status=409)
                if assignment["executorKind"] not in ("codex", "claude"):
                    raise CollaborationError("image_runtime_unsupported", "Image attachments currently require Codex or Claude.", status=400)
        return {
            **parsed,
            **({"attachments": images} if images else {}),
            **({"messageAttachments": message_images} if message_images else {}),
        }
