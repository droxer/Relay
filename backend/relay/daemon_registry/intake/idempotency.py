"""Idempotent run admission: replaying a run request by key or session, and resuming a prepared one.
"""

from __future__ import annotations

from typing import Any


from ...collaboration.models import (
    COLLABORATION_ADMISSION_EXPIRED_STATE_KEY,
    COLLABORATION_FINGERPRINT_STATE_KEY,
    COLLABORATION_MANIFEST_STATE_KEY,
    CollaborationIdempotencyError,
)
from ...sessions.controller import SessionController
from ...core.run_request_ids import idempotent_run_request_id
from .state import NodeBackendState
from .ownership import _SOURCE_CHANGED_ERROR, assert_session_owned_by_user


class RunIdempotencyMixin(NodeBackendState):
    def idempotent_run(
        self,
        idempotency_key: str,
        actor_user_id: str | None,
        *,
        actor_is_admin: bool = False,
        expected_fingerprint: str | None = None,
    ) -> dict[str, Any] | None:
        with self.registry.dispatch_lock:
            request = self.registry.daemon_store.get_run_request(
                idempotent_run_request_id(idempotency_key)
            )
            if not request:
                return None
            self._validate_idempotency_fingerprint(request, expected_fingerprint)
            if (request.get("state") or {}).get(
                COLLABORATION_ADMISSION_EXPIRED_STATE_KEY
            ):
                return None
            if request.get("status") == "prepared":
                return None
            session = self.registry.store.get_session(request["sessionId"])
            if actor_user_id and not actor_is_admin:
                assert_session_owned_by_user(
                    self.registry.store, session["id"], actor_user_id
                )
            self._raise_rejected_recovery(request)
            return self._reconcile_idempotent_participants(
                request, session, actor_user_id
            )

    def idempotent_session_run(
        self,
        session_id: str,
        actor_user_id: str | None,
        *,
        actor_is_admin: bool = False,
        expected_fingerprint: str | None = None,
    ) -> dict[str, Any] | None:
        with self.registry.dispatch_lock:
            request = (
                self.registry.daemon_store.active_run_request_for_session_any_node(
                    session_id
                )
            )
            if not request:
                return None
            try:
                self._validate_idempotency_fingerprint(request, expected_fingerprint)
            except CollaborationIdempotencyError:
                return None
            if request.get("status") == "prepared":
                return None
            session = self.registry.store.get_session(request["sessionId"])
            if actor_user_id and not actor_is_admin:
                assert_session_owned_by_user(
                    self.registry.store, session["id"], actor_user_id
                )
            return self._reconcile_idempotent_participants(
                request, session, actor_user_id
            )

    def _reconcile_idempotent_participants(
        self,
        run_request: dict[str, Any],
        session: dict[str, Any],
        actor_user_id: str | None,
    ) -> dict[str, Any]:
        """Repair room admission if dispatch committed before that event did."""
        manifest = (run_request.get("state") or {}).get(
            COLLABORATION_MANIFEST_STATE_KEY
        )
        if not isinstance(manifest, dict):
            return session
        agent_ids = [
            assignment["agentId"]
            for assignment in manifest.get("assignments", [])
            if isinstance(assignment, dict)
            and isinstance(assignment.get("agentId"), str)
            and assignment["agentId"]
        ]
        if not agent_ids:
            return session
        return SessionController(self.registry.store).record_participants_joined(
            session["id"], agent_ids, actor_user_id
        )

    @staticmethod
    def _run_request_id(request: dict[str, Any]) -> str | None:
        idempotency_key = request.get("idempotencyKey")
        if not isinstance(idempotency_key, str) or not idempotency_key:
            return None
        return idempotent_run_request_id(idempotency_key)

    def _idempotent_session(
        self, request: dict[str, Any], run_request_id: str | None
    ) -> dict[str, Any] | None:
        existing_request = (
            self.registry.daemon_store.get_run_request(run_request_id)
            if run_request_id
            else self.registry.daemon_store.active_run_request_for_session_any_node(
                request.get("sessionId")
            )
            if isinstance(request.get("sessionId"), str)
            else None
        )
        if not existing_request:
            return None
        self._validate_idempotency_fingerprint(
            existing_request, request.get("idempotencyFingerprint")
        )
        if (existing_request.get("state") or {}).get(
            COLLABORATION_ADMISSION_EXPIRED_STATE_KEY
        ):
            return None
        if existing_request.get("status") == "prepared":
            return None
        session = self.registry.store.get_session(existing_request["sessionId"])
        actor_user_id = request.get("actorUserId")
        if actor_user_id and request.get("actorIsAdmin") is not True:
            assert_session_owned_by_user(
                self.registry.store, session["id"], actor_user_id
            )
        self._raise_rejected_recovery(existing_request)
        return session

    @staticmethod
    def _raise_rejected_recovery(request: dict[str, Any]) -> None:
        error = request.get("error")
        if request.get("status") == "failed" and isinstance(error, str) and (
            error == _SOURCE_CHANGED_ERROR or error.startswith(("task_ownership_changed:", "task_wip_limit:"))
        ):
            raise ValueError(error)

    @staticmethod
    def _validate_idempotency_fingerprint(
        run_request: dict[str, Any], expected_fingerprint: str | None
    ) -> None:
        if not expected_fingerprint:
            return
        actual = (run_request.get("state") or {}).get(
            COLLABORATION_FINGERPRINT_STATE_KEY
        )
        if actual and actual != expected_fingerprint:
            raise CollaborationIdempotencyError(
                "The idempotency key already belongs to a different collaboration intent."
            )

    def _prepared_run_request(
        self, request: dict[str, Any], run_request_id: str | None
    ) -> dict[str, Any] | None:
        if not run_request_id:
            session_id = request.get("sessionId")
            existing = (
                self.registry.daemon_store.active_run_request_for_session_any_node(
                    session_id
                )
                if isinstance(session_id, str) and session_id
                else None
            )
        else:
            existing = self.registry.daemon_store.get_run_request(run_request_id)
        if not existing or existing.get("status") != "prepared":
            return None
        self._validate_idempotency_fingerprint(
            existing, request.get("idempotencyFingerprint")
        )
        return existing

    @staticmethod
    def _resume_prepared_request(
        request: dict[str, Any], prepared: dict[str, Any]
    ) -> dict[str, Any]:
        state = prepared.get("state") or {}
        manifest = state.get(COLLABORATION_MANIFEST_STATE_KEY)
        resumes_new_thread = not request.get("sessionId")
        return {
            **request,
            "assignments": prepared["assignments"],
            "daemonNodeId": prepared["nodeId"],
            "sessionId": prepared["sessionId"],
            "taskId": prepared.get("taskId"),
            "_admissionId": prepared["id"],
            **({"_resumedPreparedNewThread": True} if resumes_new_thread else {}),
            **(
                {"collaboration": {"manifest": manifest}}
                if isinstance(manifest, dict)
                else {}
            ),
        }
