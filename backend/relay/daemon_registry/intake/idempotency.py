"""Idempotent run admission: replaying a run request by key or session, and resuming a prepared one.
"""

from __future__ import annotations

from typing import Any


from ...collaboration.models import (
    COLLABORATION_ADMISSION_EXPIRED_STATE_KEY,
    COLLABORATION_FINGERPRINT_STATE_KEY,
    COLLABORATION_MANIFEST_STATE_KEY,
    COLLABORATION_MESSAGE_RECEIPT_STATE_KEY,
    CollaborationIdempotencyError,
    MessageReceiptUnavailableError,
    project_id_for_task_handoff,
)
from ...sessions.controller import SessionController
from ...core.run_request_ids import idempotent_run_request_id, message_receipt_event_id
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
        hydrate: bool = True,
        message_thread_id: str | None = None,
        message_fingerprint: str | None = None,
        read_message_receipt: bool = False,
        receipt_only: bool = False,
        message_user_id: str | None = None,
    ) -> dict[str, Any] | None:
        with self.registry.dispatch_lock:
            request_id = idempotent_run_request_id(idempotency_key)
            session_id = message_thread_id or request_id
            # A replay at the HTTP boundary compares the submitted address,
            # before resolving names against the current roster.
            receipt = None
            if message_fingerprint is not None:
                receipt = self._message_receipt(session_id, request_id, "inputFingerprint", message_fingerprint)
                if receipt is None and receipt_only:
                    return None
            request = self.registry.daemon_store.get_run_request(request_id)
            if not request:
                if receipt is None and read_message_receipt:
                    receipt = self._message_receipt(session_id, request_id, "fingerprint", expected_fingerprint)
                if receipt is None:
                    if read_message_receipt:
                        self._assert_no_legacy_message(session_id, request_id, message_user_id)
                    return None
                session = self.registry.store.get_session_header(session_id)
                self._assert_replay_owner(session_id, actor_user_id, actor_is_admin)
                return self.registry.store.get_session(session_id) if hydrate else session
            if receipt is None:
                self._validate_idempotency_fingerprint(request, expected_fingerprint)
            if (request.get("state") or {}).get(
                COLLABORATION_ADMISSION_EXPIRED_STATE_KEY
            ):
                return None
            if request.get("status") == "prepared" and receipt is None:
                return None
            session = self.registry.store.get_session_header(request["sessionId"])
            self._assert_replay_owner(session["id"], actor_user_id, actor_is_admin)
            self._raise_rejected_recovery(request)
            return self._reconcile_idempotent_participants(
                request, session, actor_user_id, hydrate=hydrate,
            )

    def legacy_message_address(self, idempotency_key: str, session_id: str) -> dict[str, Any] | None:
        request = self.registry.daemon_store.get_run_request(idempotent_run_request_id(idempotency_key))
        if not request or request["sessionId"] != session_id:
            return None
        manifest = (request.get("state") or {}).get(COLLABORATION_MANIFEST_STATE_KEY) or {}
        address = manifest.get("address")
        return address if isinstance(address, dict) else None

    def _assert_no_legacy_message(self, session_id: str, request_id: str, message_id: str | None) -> None:
        store = self.registry.store
        if session_id == request_id:
            try:
                if not store.get_session_header(session_id).get("collaborationRounds"):
                    return
            except KeyError:
                return
        elif not store.session_event(session_id, message_id or f"evt_{request_id}", "user.message"):
            return
        raise MessageReceiptUnavailableError("Relay recorded this message, but its original send receipt expired.")

    def _message_receipt(
        self, session_id: str, request_id: str, field: str, expected: str | None,
    ) -> dict[str, Any] | None:
        event = self.registry.store.session_event(
            session_id, message_receipt_event_id(request_id), "collaboration.round.started",
        )
        receipt = (event or {}).get("messageReceipt")
        if not receipt or field not in receipt:
            return None
        if receipt[field] != expected:
            raise CollaborationIdempotencyError(
                "The idempotency key already belongs to a different collaboration intent."
            )
        return receipt

    def _assert_replay_owner(self, session_id: str, actor_user_id: str | None, actor_is_admin: bool) -> None:
        if actor_user_id and not actor_is_admin:
            assert_session_owned_by_user(self.registry.store, session_id, actor_user_id)

    def idempotent_session_run(
        self,
        session_id: str,
        actor_user_id: str | None,
        *,
        actor_is_admin: bool = False,
        expected_fingerprint: str | None = None,
        hydrate: bool = True,
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
            session = self.registry.store.get_session_header(request["sessionId"])
            if actor_user_id and not actor_is_admin:
                assert_session_owned_by_user(
                    self.registry.store, session["id"], actor_user_id
                )
            return self._reconcile_idempotent_participants(
                request, session, actor_user_id, hydrate=hydrate,
            )

    def _reconcile_idempotent_participants(
        self,
        run_request: dict[str, Any],
        session: dict[str, Any],
        actor_user_id: str | None,
        *,
        hydrate: bool,
    ) -> dict[str, Any]:
        """Repair room admission if dispatch committed before that event did."""
        manifest = (run_request.get("state") or {}).get(
            COLLABORATION_MANIFEST_STATE_KEY
        )
        if not isinstance(manifest, dict) or project_id_for_task_handoff(manifest, run_request.get("taskId")):
            return self.registry.store.get_session(session["id"]) if hydrate else session
        agent_ids = [
            assignment["agentId"]
            for assignment in manifest.get("assignments", [])
            if isinstance(assignment, dict)
            and isinstance(assignment.get("agentId"), str)
            and assignment["agentId"]
        ]
        if not agent_ids:
            return self.registry.store.get_session(session["id"]) if hydrate else session
        return SessionController(self.registry.store).record_participants_joined(
            session["id"], agent_ids, actor_user_id, hydrate=hydrate,
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
        receipt = None
        if run_request_id and (submitted := request.get("messageReceipt")):
            session_id: str = request.get("sessionId") or run_request_id
            if (message_fingerprint := submitted.get("inputFingerprint")) is not None:
                receipt = self._message_receipt(session_id, run_request_id, "inputFingerprint", message_fingerprint)
            if not existing_request:
                if not receipt:
                    receipt = self._message_receipt(
                        session_id, run_request_id, "fingerprint", request.get("idempotencyFingerprint"),
                    )
                if receipt:
                    self._assert_replay_owner(session_id, request.get("actorUserId"), request.get("actorIsAdmin") is True)
                    return self.registry.store.get_session_header(session_id) if request.get("_hydrateSession") is False else self.registry.store.get_session(session_id)
                self._assert_no_legacy_message(session_id, run_request_id, request.get("userMessageId"))
        if not existing_request:
            return None
        if receipt is None:
            self._validate_idempotency_fingerprint(
                existing_request, request.get("idempotencyFingerprint")
            )
        if (existing_request.get("state") or {}).get(
            COLLABORATION_ADMISSION_EXPIRED_STATE_KEY
        ):
            return None
        if existing_request.get("status") == "prepared":
            return None
        session = self.registry.store.get_session_header(existing_request["sessionId"])
        actor_user_id = request.get("actorUserId")
        if actor_user_id and request.get("actorIsAdmin") is not True:
            assert_session_owned_by_user(
                self.registry.store, session["id"], actor_user_id
            )
        self._raise_rejected_recovery(existing_request)
        return session if request.get("_hydrateSession") is False else self.registry.store.get_session(session["id"])

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
    def _prepared_message_receipt(request: dict[str, Any], admitted: dict[str, Any]) -> dict[str, str] | None:
        incoming = request.get("messageReceipt")
        frozen = (admitted.get("state") or {}).get(COLLABORATION_MESSAGE_RECEIPT_STATE_KEY)
        incoming_fingerprint = (incoming or {}).get("inputFingerprint")
        frozen_fingerprint = (frozen or {}).get("inputFingerprint")
        if incoming_fingerprint and frozen_fingerprint and incoming_fingerprint != frozen_fingerprint:
            raise CollaborationIdempotencyError(
                "The idempotency key already belongs to a different collaboration intent."
            )
        return frozen or incoming

    @staticmethod
    def _resume_prepared_request(
        request: dict[str, Any], prepared: dict[str, Any]
    ) -> dict[str, Any]:
        state = prepared.get("state") or {}
        manifest = state.get(COLLABORATION_MANIFEST_STATE_KEY)
        resumes_new_thread = not request.get("sessionId")
        return {
            **request,
            "messageReceipt": RunIdempotencyMixin._prepared_message_receipt(request, prepared),
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
