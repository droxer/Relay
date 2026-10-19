"""What people say into a thread and who is in its room."""

from __future__ import annotations

from typing import Any

from loguru import logger

from ..persistence.events import relay_event
from .controller_state import SessionControllerState


class SessionMessageMixin(SessionControllerState):
    def record_user_message(
        self,
        session_id: str,
        text: str,
        actor_user_id: str | None = None,
        message_id: str | None = None,
    ) -> dict[str, Any]:
        payload: dict[str, Any] = {"text": text}
        if actor_user_id:
            payload["actorUserId"] = actor_user_id
        event = relay_event("user.message", session_id, payload)
        if message_id:
            event["id"] = message_id
        session = self._append(session_id, event)
        logger.info(
            "User message recorded", session_id=session_id, message_id=event["id"]
        )
        return session

    def record_participants_joined(
        self,
        session_id: str,
        agent_ids: list[str],
        actor_user_id: str | None = None,
    ) -> dict[str, Any]:
        """Admit agents to the thread's room, addressed into it by a message."""
        current = self.store.get_session(session_id)
        roster = current.get("participantAgentIds") or []
        newcomers = [
            agent_id
            for agent_id in dict.fromkeys(agent_ids)
            if agent_id and agent_id not in roster
        ]
        if not newcomers:
            return current
        payload: dict[str, Any] = {"agentIds": newcomers}
        if actor_user_id:
            payload["actorUserId"] = actor_user_id
        session = self._append(
            session_id,
            relay_event("thread.participants_joined", session_id, payload),
        )
        logger.info(
            "Thread participants joined", session_id=session_id, agent_ids=newcomers
        )
        return session
