"""Human decisions on a thread: cancel, approve, reject, mark done, rerun,
and answers to a live run's permission prompt."""

from __future__ import annotations

from typing import Any

from loguru import logger

from ..core.ids import new_relay_id, now_iso
from ..core.permission_requests import (
    may_grant_always,
    open_permission_request,
    standing_grant,
    validate_answers,
)
from ..persistence.events import relay_event
from .controller_state import SessionControllerState


def _decided_by(actor_user_id: str | None) -> dict[str, str]:
    """Who made a human decision — the audit trail of every approval."""
    return {"actorUserId": actor_user_id} if actor_user_id else {}


class SessionDecisionMixin(SessionControllerState):
    def cancel_session(
        self, session_id: str, note: str = "Cancelled by human.",
        *, actor_user_id: str | None = None,
    ) -> dict[str, Any]:
        with self._transaction():
            return self._cancel_session(
                session_id, note, actor_user_id=actor_user_id
            )

    def _cancel_session(
        self, session_id: str, note: str = "Cancelled by human.",
        *, actor_user_id: str | None = None,
    ) -> dict[str, Any]:
        current = self.store.get_session(session_id)
        if current["status"] == "cancelled":
            return current
        session = self._append(
            session_id,
            relay_event(
                "human.decision",
                session_id,
                {
                    "decision": {
                        "id": new_relay_id("dec"),
                        "kind": "cancel",
                        "createdAt": now_iso(),
                        "note": note,
                        **_decided_by(actor_user_id),
                    }
                },
            ),
        )
        self._update_task_status("blocked", note, {"sessionId": session_id, "code": "execution_cancelled"})
        logger.info("Session cancelled", session_id=session_id, note=note)
        return session

    def resolve_permission_request(
        self,
        session_id: str,
        request_id: str,
        decision: str,
        note: str | None = None,
        *,
        answers: Any = None,
        always: bool = False,
        actor_user_id: str | None = None,
    ) -> dict[str, Any] | None:
        """Answer a live run's permission prompt; None when it is no longer
        open. A question prompt is allowed with `answers`, which must answer
        every question it asked (ValueError otherwise). `always` allows this
        prompt and every later one from the same agent for the same tool in
        this thread; it never answers a question."""
        if always and decision != "allow":
            raise ValueError("only allow can be always.")
        with self.store.mutation_scope(session_id):
            request = open_permission_request(self.store.get_session(session_id), request_id)
            if not request:
                return None
            if always and not may_grant_always(request):
                raise ValueError("a question cannot be always allowed.")
            checked = (
                validate_answers(request, answers)
                if decision == "allow" and request.get("questions")
                else None
            )
            logger.info(
                "Permission request answered",
                session_id=session_id,
                request_id=request_id,
                decision=decision,
                always=always,
            )
            session = self._append(
                session_id,
                relay_event(
                    "agent.permission_resolved",
                    session_id,
                    {
                        "requestId": request_id,
                        "decision": decision,
                        **({"note": note} if note else {}),
                        **({"answers": checked} if checked else {}),
                        **({"always": True} if always else {}),
                        **_decided_by(actor_user_id),
                    },
                ),
            )
            return self._allow_granted_prompts(session_id, session) if always else session

    def _allow_granted_prompts(self, session_id: str, session: dict[str, Any]) -> dict[str, Any]:
        """A new grant also answers the prompts already waiting that it covers
        — a run may have asked twice before its person replied."""
        for request in list(session.get("permissionRequests") or []):
            if standing_grant(session, request):
                session = self._append(
                    session_id,
                    relay_event(
                        "agent.permission_resolved",
                        session_id,
                        {"requestId": request["id"], "decision": "allow", "grant": True},
                    ),
                )
        return session

    def record_decision(
        self,
        session_id: str,
        kind: str,
        note: str | None = None,
        target_agent: str | None = None,
        *,
        decision_id: str | None = None,
        actor_user_id: str | None = None,
    ) -> dict[str, Any]:
        with self._transaction():
            return self._record_decision(
                session_id, kind, note, target_agent, decision_id=decision_id,
                actor_user_id=actor_user_id,
            )

    def _record_decision(
        self,
        session_id: str,
        kind: str,
        note: str | None = None,
        target_agent: str | None = None,
        *,
        decision_id: str | None = None,
        actor_user_id: str | None = None,
    ) -> dict[str, Any]:
        if kind == "cancel":
            return self.cancel_session(
                session_id, note or "Cancelled by human.",
                actor_user_id=actor_user_id,
            )
        if decision_id:
            current = self.store.get_session(session_id)
            if any(
                decision.get("id") == decision_id
                for decision in current.get("decisions", [])
            ):
                return current
        decision = {
            "id": decision_id or new_relay_id("dec"),
            "kind": kind,
            "createdAt": now_iso(),
            **({"note": note} if note else {}),
            **({"targetAgent": target_agent} if target_agent else {}),
            **_decided_by(actor_user_id),
        }
        logger.info(
            "Human decision recorded",
            session_id=session_id,
            kind=kind,
            target_agent=target_agent,
        )
        self._append(
            session_id,
            relay_event("human.decision", session_id, {"decision": decision}),
            hydrate=False,
        )
        if kind == "approve":
            current = self.store.get_session(session_id)
            if current.get("status") == "running":
                return self._append(
                    session_id,
                    relay_event(
                        "session.status",
                        session_id,
                        {"status": "running", "phase": "approved"},
                    ),
                )
            if current.get("status") == "waiting_for_human":
                # Approving a rejected turn accepts it after all. Nothing is
                # dispatched, so the thread settles instead of claiming a run.
                return self._append(
                    session_id,
                    relay_event(
                        "session.status",
                        session_id,
                        {"status": "completed", "phase": "approved"},
                    ),
                )
            # A terminal thread keeps its status; the decision is the record.
            return current
        if kind == "reject":
            return self._append(
                session_id,
                relay_event(
                    "session.status",
                    session_id,
                    {
                        "status": "waiting_for_human",
                        "phase": "feedback",
                        "pendingDecision": "feedback",
                    },
                ),
            )
        if kind == "mark_done":
            return self.complete_session(
                session_id, note or "Marked done from Relay API.",
                work_outcome="accepted", accepted_by_human=True,
            )
        if kind == "rerun":
            return self._append(
                session_id,
                relay_event(
                    "session.status",
                    session_id,
                    {
                        "status": "running",
                        "phase": f"rerun:{target_agent}" if target_agent else "rerun",
                    },
                ),
            )
        if kind == "handoff" and target_agent:
            return self._append(
                session_id,
                relay_event(
                    "session.status",
                    session_id,
                    {
                        "status": "running",
                        "phase": f"handoff:{target_agent}",
                    },
                ),
            )
        return self.store.get_session(session_id)
