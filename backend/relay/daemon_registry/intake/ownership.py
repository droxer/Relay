"""Who may run in a session: the run's owner, the session-ownership check, and source-round ownership.

``assert_session_owned_by_user`` is the authorization seam: a user's agent may only
act on sessions its user owns.
"""

from __future__ import annotations

from typing import Any


from ...collaboration.models import (
    COLLABORATION_MANIFEST_STATE_KEY,
)
from ...core.ids import now_iso
from ...persistence.protocols import SessionStore
from .state import NodeBackendState


_SOURCE_CHANGED_ERROR = (
    "handoff_source_changed: the source round changed; request recovery again."
)


class RunOwnershipMixin(NodeBackendState):
    def _run_owner(
        self, request: dict[str, Any], sandbox: dict[str, Any]
    ) -> tuple[str | None, str | None, str | None]:
        actor_user_id = request.get("actorUserId")
        owner_agent_id = next(
            (
                assignment.get("agentId")
                for assignment in request["assignments"]
                if assignment.get("agentId")
            ),
            None,
        )
        owner_user_id = (
            (self.agent_store.get_agent(owner_agent_id) or {}).get(
                "supervisorUserId"
            )
            if owner_agent_id and self.agent_store
            else actor_user_id or sandbox.get("userId")
        )
        return actor_user_id, owner_agent_id, owner_user_id

    def _validate_existing_session(
        self,
        request: dict[str, Any],
        owner_user_id: str | None,
        *,
        run_request_id: str | None = None,
    ) -> None:
        session_id = request.get("sessionId")
        if not session_id:
            return
        if not owner_user_id:
            raise PermissionError("Logical agent has no supervisor.")
        assert_session_owned_by_user(
            self.registry.store, session_id, owner_user_id
        )
        active = self.registry.daemon_store.active_run_request_for_session_any_node(
            session_id
        )
        if active and active.get("id") != run_request_id:
            raise ValueError(f"Session {session_id} already has an active daemon run.")

    def _validate_source_ownership(
        self, run_request: dict[str, Any], session: dict[str, Any]
    ) -> None:
        # Check AFTER the durable reservation, not just under the process-local
        # dispatch lock. The active-session unique index prevents a competing
        # admission on another backend replica from replacing this owner while
        # we persist its round. Check the frozen manifest on prepared retries.
        manifest = (run_request.get("state") or {}).get(
            COLLABORATION_MANIFEST_STATE_KEY
        ) or {}
        source = manifest.get("sourceOwnership")
        if source is None:  # Legacy prepared requests have no revision token.
            return
        revision = session.get("collaborationRevision", 0)
        round_id = session.get("activeRoundId")
        expected = source.get("revision") if isinstance(source, dict) else None
        if type(expected) is int and expected >= 0 and (
            (revision == expected and round_id == source.get("roundId"))
            or (
                revision == expected + 1
                and round_id == manifest.get("roundId")
            )
        ):
            return
        # Do not fail the session or its task: they belong to the newer owner.
        self.registry.daemon_store.update_run_request_if_status(
            run_request["id"], "prepared",
            {"status": "failed", "error": _SOURCE_CHANGED_ERROR, "completedAt": now_iso()},
        )
        raise ValueError(_SOURCE_CHANGED_ERROR)


def assert_session_owned_by_user(
    store: SessionStore, session_id: str, user_id: str
) -> None:
    try:
        session = store.get_session(session_id)
    except Exception as exc:
        raise PermissionError(
            f"Session {session_id} could not be verified for {user_id}."
        ) from exc
    if not session.get("ownerUserId"):
        raise PermissionError(
            f"Session {session_id} has no owner; {user_id} is not authorized to run it."
        )
    if session["ownerUserId"] != user_id:
        raise PermissionError(
            f"Session {session_id} is owned by {session['ownerUserId']}; {user_id} is not authorized to run it."
        )
