"""Assigning agents to a thread, handing it off, and recording its artifacts."""

from __future__ import annotations

import json
from typing import Any

from loguru import logger

from ..core.ids import new_relay_id, now_iso
from ..persistence.events import relay_event
from .controller_state import SessionControllerState
from .decisions import _decided_by
from .errors import SessionArchivedError, SessionRunInFlightError


class SessionAssignmentMixin(SessionControllerState):
    def handoff_session(
        self,
        session_id: str,
        target_agent: str,
        assignments: list[dict[str, Any]],
        note: str | None = None,
        target_agent_id: str | None = None,
        *,
        decision_id: str | None = None,
        actor_user_id: str | None = None,
    ) -> dict[str, Any]:
        # A decision ID is the retry receipt. It must not become durable
        # before the assignment artifact and final handoff status do.
        with self._transaction():
            return self._handoff_session(
                session_id, target_agent, assignments, note, target_agent_id,
                decision_id=decision_id, actor_user_id=actor_user_id,
            )

    def _handoff_session(
        self,
        session_id: str,
        target_agent: str,
        assignments: list[dict[str, Any]],
        note: str | None = None,
        target_agent_id: str | None = None,
        *,
        decision_id: str | None = None,
        actor_user_id: str | None = None,
    ) -> dict[str, Any]:
        if decision_id:
            current = self.store.get_session(session_id)
            if any(
                decision.get("id") == decision_id
                for decision in current.get("decisions", [])
            ):
                return current
        self._validate_assignment(session_id)
        self._append(
            session_id,
            relay_event(
                "human.decision",
                session_id,
                {
                    "decision": {
                        "id": decision_id or new_relay_id("dec"),
                        "kind": "handoff",
                        "createdAt": now_iso(),
                        **({"note": note} if note else {}),
                        "targetAgent": target_agent,
                        **(
                            {"targetAgentId": target_agent_id}
                            if target_agent_id
                            else {}
                        ),
                        **_decided_by(actor_user_id),
                    }
                },
            ),
            hydrate=False,
        )
        self.assign_session(session_id, assignments)
        logger.info("Session handoff", session_id=session_id, target_agent=target_agent)
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

    def assign_session(
        self, session_id: str, assignments: list[dict[str, Any]]
    ) -> dict[str, Any]:
        self._validate_assignment(session_id)
        self.create_artifact(
            session_id,
            {
                "kind": "plan",
                "title": "Assignment plan",
                "body": json.dumps({"assignments": assignments}, indent=2),
                "extension": "json",
            },
        )
        logger.info(
            "Session assignments updated",
            session_id=session_id,
            assignments=[
                {"executorKind": a.get("executorKind") or a["agent"]}
                for a in assignments
            ],
        )
        return self._append(
            session_id,
            relay_event(
                "session.status",
                session_id,
                {
                    "status": "running",
                    "phase": "assigned",
                },
            ),
        )

    def _validate_assignment(self, session_id: str) -> None:
        snapshot = self.store.get_session(session_id)
        if snapshot.get("archived") or snapshot.get("deletionRequestedAt"):
            raise SessionArchivedError(session_id)
        if any(run.get("status") == "running" for run in snapshot.get("agentRuns", [])):
            raise SessionRunInFlightError(session_id)

    def create_artifact(
        self, session_id: str, payload: dict[str, Any]
    ) -> dict[str, Any]:
        if hasattr(self.store, "create_artifact"):
            artifact, _session = self.store.create_artifact(session_id, payload)
            logger.debug(
                "Artifact created",
                session_id=session_id,
                artifact_id=artifact["id"],
                kind=payload.get("kind"),
            )
            return artifact
        artifact = self.store.write_artifact(session_id, payload)
        self._append(
            session_id,
            relay_event("artifact.created", session_id, {"artifact": artifact}),
            hydrate=False,
        )
        logger.debug(
            "Artifact created",
            session_id=session_id,
            artifact_id=artifact["id"],
            kind=payload.get("kind"),
        )
        return artifact
