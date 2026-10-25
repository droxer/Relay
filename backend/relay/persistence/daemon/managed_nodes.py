"""Managed-node desired state, provisioning attempts, and enrollment grants."""

from __future__ import annotations

import hashlib
import hmac
import json
import secrets
from collections.abc import Iterator
from contextlib import contextmanager, nullcontext
from datetime import datetime, timedelta, UTC
from typing import Any
from uuid import uuid4

from sqlalchemy import delete, insert, select, update

from ..engine import create_all_tables, shared_engine, store_transaction
from ..resource_lock import resource_transaction
from ..tables import managed_nodes as managed_nodes_tables
from ...core.ids import now_iso
from ...core.managed_node_policy import (
    ATTEMPT_HISTORY_LIMIT,
    DEFAULT_MANAGED_NODE_PROVIDER,
    MANAGED_NODE_ASSIGNMENT_MODES,
    MANAGED_NODE_DESIRED_STATES,
    MANAGED_NODE_PHASES,
    ManagedCapacityResolution,
    PROVISIONING_ATTEMPT_STATUSES,
    TERMINAL_ATTEMPT_STATUSES,
    managed_sandbox_mode_for,
    validate_managed_provider,
    validate_managed_sandbox_mode,
)


def _new_id(prefix: str) -> str:
    return f"{prefix}_{uuid4().hex}"


def _secret_hash(secret: str) -> str:
    return hashlib.sha256(secret.encode("utf-8")).hexdigest()


def _parse_timestamp(value: str) -> datetime:
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


def _normalize_user_id(value: Any) -> str:
    if not isinstance(value, str) or not value.strip():
        raise ValueError("userId is required for a dedicated managed node.")
    return value.strip()


def _managed_node_policy_slot(node: dict[str, Any], default_provider: str) -> tuple[Any, ...]:
    provider = node.get("provider") or default_provider
    return (
        node.get("assignmentMode") or "dedicated",
        provider,
        node.get("providerConfigRef"),
        node.get("profile") or "standard",
        node.get("sandboxMode") or managed_sandbox_mode_for(provider),
        json.dumps(
            node.get("workspacePolicy") or {"kind": "user-home"},
            sort_keys=True,
            separators=(",", ":"),
        ),
    )


class DatabaseManagedNodeStore:
    """Durable store for managed-node desired state and attempts."""

    records = managed_nodes_tables.records

    def __init__(
        self,
        database_url: str,
        *,
        create_schema: bool = False,
        default_provider: str = DEFAULT_MANAGED_NODE_PROVIDER,
    ):
        # The provider a node gets when its request names none; a deployment
        # picks it with RELAY_MANAGED_NODE_PROVIDER.
        self.default_provider = default_provider
        self.engine = shared_engine(database_url)
        if create_schema:
            create_all_tables(self.engine)

    def create_node(
        self, payload: dict[str, Any], *, _policy_slot_locked: bool = False
    ) -> dict[str, Any]:
        assignment_mode = payload.get("assignmentMode") or "dedicated"
        desired_state = payload.get("desiredState") or "running"
        validate_managed_provider(payload)
        provider = payload.get("provider") or self.default_provider
        sandbox_mode = payload.get("sandboxMode") or managed_sandbox_mode_for(provider)
        if assignment_mode not in MANAGED_NODE_ASSIGNMENT_MODES:
            raise ValueError("assignmentMode must be dedicated.")
        if desired_state not in MANAGED_NODE_DESIRED_STATES:
            raise ValueError("desiredState must be running, stopped, or deleted.")
        validate_managed_sandbox_mode(sandbox_mode, provider)
        user_id = _normalize_user_id(payload.get("userId"))
        slot_lock = nullcontext() if _policy_slot_locked else self._policy_slot_lock()
        with slot_lock, self._mutation_scope():
            now = now_iso()
            node = {
                "id": str(uuid4()),
                "displayName": payload.get("displayName") or f"Managed node for {user_id or 'pool'}",
                **({"userId": user_id} if user_id else {}),
                "assignmentMode": assignment_mode,
                "provider": provider,
                **({"providerConfigRef": payload["providerConfigRef"]} if payload.get("providerConfigRef") else {}),
                "profile": payload.get("profile") or "standard",
                "sandboxMode": sandbox_mode,
                "workspacePolicy": payload.get("workspacePolicy") or {"kind": "user-home"},
                "desiredState": desired_state,
                "generation": 1,
                "phase": "requested" if desired_state == "running" else "stopped",
                "conditions": [],
                "createdAt": now,
                "updatedAt": now,
            }
            self._assert_active_policy_slot_available(node)
            self._write_node(node)
            return node

    def _assert_active_policy_slot_available(
        self, candidate: dict[str, Any], *, exclude_node_id: str | None = None
    ) -> None:
        if candidate.get("desiredState") != "running":
            return
        slot = _managed_node_policy_slot(candidate, self.default_provider)
        duplicate = next(
            (
                node
                for node in self.list_nodes()
                if node["id"] != exclude_node_id
                and node.get("desiredState") == "running"
                and node.get("userId") == candidate.get("userId")
                and _managed_node_policy_slot(node, self.default_provider) == slot
            ),
            None,
        )
        if duplicate:
            raise ValueError(
                "User already has an active managed node in this policy slot."
            )

    def ensure_node_for_user(
        self, user_id: str, *, policy: dict[str, Any] | None = None
    ) -> ManagedCapacityResolution:
        """Return managed capacity and whether provisioning was newly requested."""
        user_id = user_id.strip()
        if not user_id:
            raise ValueError("userId is required for managed capacity.")
        policy = policy or {}
        allowed_policy_fields = {
            "assignmentMode",
            "provider",
            "providerConfigRef",
            "profile",
            "sandboxMode",
            "workspacePolicy",
        }
        unknown = set(policy) - allowed_policy_fields
        if unknown:
            raise ValueError(
                f"Unsupported managed capacity policy field(s): {', '.join(sorted(unknown))}."
            )
        requested_slot = _managed_node_policy_slot(policy, self.default_provider)
        with self._policy_slot_lock(), self._mutation_scope():
            candidates = [
                node
                for node in self.list_nodes()
                if node.get("userId") == user_id
                and _managed_node_policy_slot(node, self.default_provider) == requested_slot
            ]
            existing = next(
                (node for node in candidates if node.get("desiredState") == "running"),
                candidates[0] if candidates else None,
            )
            if existing:
                if existing.get("desiredState") != "running":
                    existing = self.update_node(
                        existing["id"],
                        {"desiredState": "running"},
                        _policy_slot_locked=True,
                    )
                    return ManagedCapacityResolution(existing, True)
                return ManagedCapacityResolution(existing, False)
            return ManagedCapacityResolution(
                self.create_node(
                    {"userId": user_id, **policy},
                    _policy_slot_locked=True,
                ),
                True,
            )

    def list_nodes(self, *, include_deleted: bool = False) -> list[dict[str, Any]]:
        nodes = self._records("nodes")
        if not include_deleted:
            nodes = [node for node in nodes if node.get("desiredState") != "deleted"]
        return sorted(nodes, key=lambda item: (item.get("createdAt") or "", item["id"]))

    def get_node(self, node_id: str) -> dict[str, Any] | None:
        return self._read_record("nodes", node_id)

    def purge_node(self, node_id: str) -> dict[str, Any]:
        with self._mutation_scope(node_id):
            node = self.get_node(node_id)
            if not node:
                raise KeyError(node_id)
            if (
                node.get("desiredState") != "deleted"
                or node.get("phase") != "deleted"
            ):
                raise ValueError(
                    "Managed node must finish deletion before it can be permanently deleted."
                )
            attempts = self.list_attempts(node_id)
            if any(
                attempt.get("status") not in TERMINAL_ATTEMPT_STATUSES
                for attempt in attempts
            ):
                raise ValueError(
                    "Managed node still has an active provisioning attempt."
                )
            attempt_ids = {attempt["id"] for attempt in attempts}
            for grant in self._records("grants", node_id=node_id):
                if grant.get("attemptId") in attempt_ids:
                    self._delete_record("grants", grant["id"])
            for attempt in attempts:
                self._delete_record("attempts", attempt["id"])
            self._delete_record("nodes", node_id)
            return node

    def update_node(
        self,
        node_id: str,
        patch: dict[str, Any],
        *,
        _policy_slot_locked: bool = False,
    ) -> dict[str, Any]:
        slot_lock = nullcontext() if _policy_slot_locked else self._policy_slot_lock()
        with slot_lock, self._mutation_scope(node_id):
            node = self.get_node(node_id)
            if not node:
                raise KeyError(node_id)
            provider_fields = {"provider", "providerConfigRef", "profile", "sandboxMode", "workspacePolicy"}
            allowed_fields = provider_fields | {
                "displayName",
                "userId",
                "assignmentMode",
                "desiredState",
                "phase",
                "conditions",
            }
            unknown = set(patch) - allowed_fields
            if unknown:
                raise ValueError(f"Unsupported managed node field(s): {', '.join(sorted(unknown))}.")
            validate_managed_provider(patch)
            desired_state = patch.get("desiredState", node["desiredState"])
            if desired_state not in MANAGED_NODE_DESIRED_STATES:
                raise ValueError("desiredState must be running, stopped, or deleted.")
            sandbox_mode = patch.get("sandboxMode", node["sandboxMode"])
            provider = patch.get("provider") or node["provider"]
            if {"sandboxMode", "provider"} & set(patch) or desired_state == "running":
                validate_managed_sandbox_mode(sandbox_mode, provider)
            assignment_mode = patch.get("assignmentMode", node["assignmentMode"])
            if (
                "assignmentMode" in patch or desired_state == "running"
            ) and assignment_mode not in MANAGED_NODE_ASSIGNMENT_MODES:
                raise ValueError("assignmentMode must be dedicated.")
            user_id = patch.get("userId", node.get("userId"))
            if (
                "userId" in patch
                or "assignmentMode" in patch
                or desired_state == "running"
            ) and assignment_mode == "dedicated":
                user_id = _normalize_user_id(user_id)
                patch = {**patch, "userId": user_id}
            if "phase" in patch and patch["phase"] not in MANAGED_NODE_PHASES:
                raise ValueError("Invalid managed node phase.")
            if "conditions" in patch and not isinstance(patch["conditions"], list):
                raise ValueError("conditions must be an array.")
            updated = {**node, **patch, "updatedAt": now_iso()}
            self._assert_active_policy_slot_available(
                updated, exclude_node_id=node_id
            )
            generation_fields = provider_fields | {"desiredState"}
            generation_changed = any(
                field in patch and patch[field] != node.get(field)
                for field in generation_fields
            )
            if generation_changed:
                active_attempt = self.active_attempt(node_id)
                if (
                    active_attempt
                    and active_attempt.get("generation") == node.get("generation")
                ):
                    self.update_attempt(
                        active_attempt["id"], {"status": "cancelled"}
                    )
                updated["generation"] = int(node.get("generation") or 1) + 1
                updated["phase"] = "requested" if desired_state == "running" else updated["phase"]
                updated.pop("activeAttemptId", None)
            if desired_state != node["desiredState"]:
                updated["phase"] = {"running": "requested", "stopped": "draining", "deleted": "deleting"}[desired_state]
            self._write_node(updated)
            return updated

    def create_attempt(self, node_id: str, *, grant_ttl_seconds: int = 900) -> tuple[dict[str, Any], str]:
        with self._mutation_scope(node_id):
            node = self.get_node(node_id)
            if not node:
                raise KeyError(node_id)
            if node["desiredState"] != "running":
                raise ValueError("Managed node must desire running before provisioning.")
            active = self.active_attempt(node_id)
            if active:
                raise ValueError("Managed node already has an active provisioning attempt.")
            attempts = self.list_attempts(node_id)
            attempt_number = 1 + max((int(item.get("attemptNumber") or 0) for item in attempts if item.get("generation") == node["generation"]), default=0)
            now = now_iso()
            attempt = {
                "id": _new_id("attempt"),
                "managedNodeId": node_id,
                "generation": node["generation"],
                "attemptNumber": attempt_number,
                "status": "pending",
                "startedAt": now,
                "updatedAt": now,
            }
            secret = secrets.token_urlsafe(32)
            grant_id = _new_id("grant")
            expires_at = (datetime.now(UTC) + timedelta(seconds=grant_ttl_seconds)).isoformat().replace("+00:00", "Z")
            grant = {
                "id": grant_id,
                "attemptId": attempt["id"],
                "secretHash": _secret_hash(secret),
                "expiresAt": expires_at,
                "createdAt": now,
            }
            self._write_record("attempts", attempt)
            self._write_record("grants", grant)
            self._write_node({**node, "activeAttemptId": attempt["id"], "phase": "allocating", "updatedAt": now})
            self._prune_attempt_history(node_id)
            return attempt, f"{grant_id}.{secret}"

    def _prune_attempt_history(self, node_id: str) -> None:
        """Drop the oldest terminal attempts, and any grant they still own."""
        terminal = [
            attempt
            for attempt in self.list_attempts(node_id)
            if attempt.get("status") in TERMINAL_ATTEMPT_STATUSES
        ]
        stale = terminal[: max(len(terminal) - ATTEMPT_HISTORY_LIMIT, 0)]
        for attempt in stale:
            self._delete_record("attempts", attempt["id"])
        self._sweep_grants({attempt["id"] for attempt in stale})

    def list_attempts(self, node_id: str) -> list[dict[str, Any]]:
        attempts = self._records("attempts", node_id=node_id)
        return sorted(
            (item for item in attempts if item.get("managedNodeId") == node_id),
            key=lambda item: (item.get("startedAt") or "", item["id"]),
        )

    def active_attempt(self, node_id: str) -> dict[str, Any] | None:
        return next((item for item in reversed(self.list_attempts(node_id)) if item.get("status") not in TERMINAL_ATTEMPT_STATUSES), None)

    def update_attempt(self, attempt_id: str, patch: dict[str, Any]) -> dict[str, Any]:
        with self._mutation_scope(attempt_id=attempt_id):
            attempt = self._get_attempt(attempt_id)
            if not attempt:
                raise KeyError(attempt_id)
            status = patch.get("status", attempt["status"])
            if status not in PROVISIONING_ATTEMPT_STATUSES:
                raise ValueError("Invalid provisioning attempt status.")
            # The daemon may enroll over HTTP before provider.ensure returns.
            # Accept the provider's late identity without regressing enrollment.
            if (
                attempt["status"] == "succeeded"
                and status == "registering"
                and set(patch) <= {"status", "providerInstanceId", "providerOperationId"}
            ):
                patch = {**patch, "status": "succeeded"}
                status = "succeeded"
            if (
                attempt["status"] in TERMINAL_ATTEMPT_STATUSES
                and status != attempt["status"]
            ):
                raise ValueError("Provisioning attempt is already terminal.")
            allowed = {"status", "providerInstanceId", "providerOperationId", "errorCode", "errorMessage", "retryAt"}
            unknown = set(patch) - allowed
            if unknown:
                raise ValueError(f"Unsupported provisioning attempt field(s): {', '.join(sorted(unknown))}.")
            now = now_iso()
            updated = {**attempt, **patch, "updatedAt": now}
            if status in TERMINAL_ATTEMPT_STATUSES:
                updated["finishedAt"] = attempt.get("finishedAt") or now
            self._write_record("attempts", updated)
            if attempt["status"] in TERMINAL_ATTEMPT_STATUSES:
                return updated
            node = self.get_node(attempt["managedNodeId"])
            if node:
                phase_by_status = {
                    "pending": "allocating",
                    "claimed": "allocating",
                    "allocating": "allocating",
                    "bootstrapping": "bootstrapping",
                    "registering": "registering",
                }
                node_patch = {**node, "updatedAt": now}
                if status in phase_by_status:
                    node_patch["phase"] = phase_by_status[status]
                if status == "failed":
                    retry_scheduled = bool(updated.get("retryAt")) and node.get("desiredState") == "running"
                    node_patch["phase"] = "recovering" if retry_scheduled else "failed"
                    node_patch["conditions"] = [
                        {
                            "type": "Provisioned",
                            "status": "Unknown" if retry_scheduled else "False",
                            "reason": patch.get("errorCode") or "provisioning_failed",
                            "message": patch.get("errorMessage") or "Managed node provisioning failed.",
                            "updatedAt": now,
                        }
                    ]
                if status in TERMINAL_ATTEMPT_STATUSES and node.get("activeAttemptId") == attempt_id:
                    node_patch.pop("activeAttemptId", None)
                self._write_node(node_patch)
            return updated

    def consume_enrollment_grant(self, credential: str) -> tuple[dict[str, Any], dict[str, Any]]:
        grant_id, separator, secret = credential.partition(".")
        if not separator or not grant_id or not secret:
            raise PermissionError("Invalid enrollment credential.")
        with self._mutation_scope(grant_id=grant_id):
            grant = self._read_record("grants", grant_id)
            if not grant:
                raise PermissionError("Invalid enrollment credential.")
            if grant.get("revokedAt"):
                raise PermissionError("Enrollment grant has been revoked.")
            if grant.get("consumedAt") and not grant.get("daemonNodeId"):
                raise PermissionError("Enrollment grant has already been consumed.")
            if _parse_timestamp(grant["expiresAt"]) <= datetime.now(UTC):
                raise PermissionError("Enrollment grant has expired.")
            if not hmac.compare_digest(grant["secretHash"], _secret_hash(secret)):
                raise PermissionError("Invalid enrollment credential.")
            attempt = self._get_attempt(grant["attemptId"])
            if not attempt:
                raise PermissionError("Provisioning attempt is not active.")
            node = self.get_node(attempt["managedNodeId"])
            if not node or node.get("desiredState") != "running" or node.get("generation") != attempt.get("generation"):
                raise PermissionError("Managed node no longer accepts this enrollment grant.")
            if (
                attempt.get("status") in TERMINAL_ATTEMPT_STATUSES
                and attempt.get("status") != "succeeded"
            ):
                raise PermissionError("Provisioning attempt is not active.")
            return node, attempt

    def complete_enrollment_grant(
        self, credential: str, daemon_node_id: str
    ) -> None:
        grant_id, separator, secret = credential.partition(".")
        if not separator or not grant_id or not secret:
            raise PermissionError("Invalid enrollment credential.")
        with self._mutation_scope(grant_id=grant_id):
            grant = self._read_record("grants", grant_id)
            if not grant:
                raise PermissionError("Invalid enrollment credential.")
            if not hmac.compare_digest(
                grant["secretHash"], _secret_hash(secret)
            ):
                raise PermissionError("Invalid enrollment credential.")
            existing_daemon_node_id = grant.get("daemonNodeId")
            if (
                existing_daemon_node_id
                and existing_daemon_node_id != daemon_node_id
            ):
                raise PermissionError(
                    "Enrollment grant belongs to a different daemon runtime."
                )
            self._write_record(
                "grants",
                {
                    **grant,
                    "daemonNodeId": daemon_node_id,
                    "consumedAt": grant.get("consumedAt") or now_iso(),
                },
            )

    def complete_enrollment(self, node_id: str, attempt_id: str, daemon_node_id: str) -> tuple[dict[str, Any], dict[str, Any]]:
        with self._mutation_scope(node_id):
            attempt = self.update_attempt(attempt_id, {"status": "succeeded"})
            node = self.get_node(node_id)
            if not node:
                raise KeyError(node_id)
            updated = {
                **node,
                "activeDaemonNodeId": daemon_node_id,
                "phase": "registering",
                "updatedAt": now_iso(),
            }
            updated.pop("activeAttemptId", None)
            self._write_node(updated)
            return updated, attempt

    def mark_ready(self, daemon_node_id: str) -> dict[str, Any] | None:
        candidate = next((item for item in self.list_nodes() if item.get("activeDaemonNodeId") == daemon_node_id), None)
        if not candidate:
            return None
        node_id = candidate["id"]
        with self._mutation_scope(node_id):
            node = self.get_node(node_id)
            if not node or node.get("desiredState") != "running" or node.get("activeDaemonNodeId") != daemon_node_id:
                return None
            current_attempt = next((
                attempt for attempt in reversed(self.list_attempts(node["id"]))
                if attempt.get("generation") == node.get("generation")
                and attempt.get("status") == "succeeded"
            ), None)
            if not current_attempt:
                return None
            updated = {**node, "phase": "ready", "conditions": [], "updatedAt": now_iso()}
            self._write_node(updated)
            return updated

    def _get_attempt(self, attempt_id: str) -> dict[str, Any] | None:
        return self._read_record("attempts", attempt_id)

    def _write_node(self, node: dict[str, Any]) -> None:
        self._write_record("nodes", node)

    @contextmanager
    def _policy_slot_lock(self) -> Iterator[None]:
        # Only desired-capacity changes contend on the policy lock. Progress,
        # attempts and enrollment use the owning node's lock instead.
        with resource_transaction(self.engine, "managed-policy"):
            yield

    @contextmanager
    def _mutation_scope(
        self,
        node_id: str | None = None,
        *,
        attempt_id: str | None = None,
        grant_id: str | None = None,
    ) -> Iterator[None]:
        if grant_id:
            grant = self._read_record("grants", grant_id)
            attempt_id = (grant or {}).get("attemptId")
        if attempt_id:
            attempt = self._read_record("attempts", attempt_id)
            node_id = (attempt or {}).get("managedNodeId")
        with resource_transaction(
            self.engine, f"managed-node:{node_id or grant_id or attempt_id or 'new'}"
        ):
            yield

    def _read_record(self, kind: str, record_id: str) -> dict[str, Any] | None:
        with store_transaction(self.engine) as conn:
            return conn.scalar(
                select(self.records.c.snapshot).where(
                    self.records.c.kind == kind, self.records.c.id == record_id
                )
            )

    def _write_record(self, kind: str, record: dict[str, Any]) -> None:
        node_id = record["id"] if kind == "nodes" else record.get("managedNodeId")
        if kind == "grants":
            attempt = self._read_record("attempts", record["attemptId"])
            node_id = (attempt or {}).get("managedNodeId")
        with store_transaction(self.engine) as conn:
            changed = conn.execute(
                update(self.records)
                .where(self.records.c.kind == kind, self.records.c.id == record["id"])
                .values(snapshot=record, node_id=node_id)
            ).rowcount
            if not changed:
                conn.execute(
                    insert(self.records).values(
                        kind=kind, id=record["id"], node_id=node_id, snapshot=record
                    )
                )

    def _delete_record(self, kind: str, record_id: str) -> None:
        with store_transaction(self.engine) as conn:
            conn.execute(
                delete(self.records).where(
                    self.records.c.kind == kind, self.records.c.id == record_id
                )
            )

    def _records(
        self, kind: str, *, node_id: str | None = None
    ) -> list[dict[str, Any]]:
        statement = select(self.records.c.snapshot).where(self.records.c.kind == kind)
        if node_id is not None:
            statement = statement.where(self.records.c.node_id == node_id)
        with store_transaction(self.engine) as conn:
            return list(conn.scalars(statement))

    def _sweep_grants(self, discarded_attempt_ids: set[str]) -> None:
        # Attempt history is bounded per node. Avoid scanning other nodes'
        # grants on every provisioning retry; expired grants are rejected at use.
        if not discarded_attempt_ids:
            return
        with store_transaction(self.engine) as conn:
            conn.execute(
                delete(self.records).where(
                    self.records.c.kind == "grants",
                    self.records.c.snapshot["attemptId"]
                    .as_string()
                    .in_(discarded_attempt_ids),
                )
            )
