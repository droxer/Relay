from __future__ import annotations

import fcntl
import hashlib
import hmac
import json
import secrets
from collections.abc import Iterator
from contextlib import contextmanager, nullcontext
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from threading import RLock
from typing import Any
from uuid import uuid4

from ..core.models import AGENT_NAMES
from ..persistence.store_common import (
    DEFAULT_RELAY_DATA_DIR,
    _read_json,
    _write_json,
    now_iso,
    safe_name,
)

MANAGED_NODE_DESIRED_STATES = frozenset({"running", "stopped", "deleted"})
# "pooled" and "shared" are reserved for future multi-employee node sharing;
# only "dedicated" is wired into agent placement sync today, so the other
# modes are rejected rather than silently accepted with no agents ever synced.
MANAGED_NODE_ASSIGNMENT_MODES = frozenset({"dedicated"})
MANAGED_NODE_SANDBOX_MODES = frozenset({"boxlite"})
MANAGED_NODE_PHASES = frozenset({
    "requested",
    "allocating",
    "bootstrapping",
    "registering",
    "recovering",
    "ready",
    "draining",
    "stopped",
    "deleting",
    "deleted",
    "failed",
})
PROVISIONING_ATTEMPT_STATUSES = frozenset({
    "pending",
    "claimed",
    "allocating",
    "bootstrapping",
    "registering",
    "succeeded",
    "failed",
    "cancelled",
})
TERMINAL_ATTEMPT_STATUSES = frozenset({"succeeded", "failed", "cancelled"})
# Terminal attempts retained per node. A node that cannot provision produces one
# attempt (and one enrollment grant) per reconcile pass, so unbounded history
# would grow the store forever and slow every list_attempts scan with it.
ATTEMPT_HISTORY_LIMIT = 20


@dataclass(frozen=True)
class ManagedCapacityResolution:
    node: dict[str, Any]
    provisioning_requested: bool


def _managed_node_status(node: dict[str, Any]) -> str:
    desired_state = node.get("desiredState")
    phase = node.get("phase")
    if desired_state != "running":
        return "stopped"
    if phase in ("ready", "failed"):
        return "failed"
    return "provisioning"


def managed_node_placeholder(node: dict[str, Any]) -> dict[str, Any]:
    """Present desired managed capacity before its current runtime is online."""
    conditions = node.get("conditions") or []
    last_error = conditions[-1].get("message") if conditions else None
    return {
        "id": node["id"],
        "managedNodeId": node["id"],
        "displayName": node.get("displayName") or node["id"],
        **({"employeeId": node["employeeId"]} if node.get("employeeId") else {}),
        "sandboxMode": node.get("sandboxMode") or "boxlite",
        "nodeLocation": "managed",
        "status": _managed_node_status(node),
        "agents": {agent: "unknown" for agent in AGENT_NAMES},
        "createdAt": node["createdAt"],
        "updatedAt": node["updatedAt"],
        "queuedCommandCount": 0,
        "activeRuns": [],
        "online": False,
        # Never seen a heartbeat, so staleness does not apply — the placeholder
        # status (provisioning/stopped/failed) must survive visualStatus.
        "stale": False,
        "provisioningPlaceholder": True,
        **({"lastError": last_error} if last_error else {}),
    }


def _new_id(prefix: str) -> str:
    return f"{prefix}_{uuid4().hex}"


def _secret_hash(secret: str) -> str:
    return hashlib.sha256(secret.encode("utf-8")).hexdigest()


def _parse_timestamp(value: str) -> datetime:
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


def _validate_managed_sandbox_mode(value: Any) -> None:
    if value not in MANAGED_NODE_SANDBOX_MODES:
        raise ValueError("Managed nodes require sandboxMode boxlite.")


def _validate_provider(payload: dict[str, Any]) -> None:
    """Reject a malformed provider name.

    The set of usable providers belongs to whichever supervisor reconciles the
    node, not to the backend, so an unknown-but-well-formed name is reported by
    the reconciler as a ProviderAvailable condition instead of being rejected
    here. Only shapes no reconciler could ever resolve are refused.
    """
    if "provider" not in payload or payload["provider"] is None:
        return
    provider = payload["provider"]
    if not isinstance(provider, str) or not provider.strip():
        raise ValueError("provider must be a non-empty string.")


def _normalize_employee_id(value: Any) -> str:
    if not isinstance(value, str) or not value.strip():
        raise ValueError("employeeId is required for a dedicated managed node.")
    return value.strip()


def _managed_node_policy_slot(node: dict[str, Any]) -> tuple[Any, ...]:
    return (
        node.get("assignmentMode") or "dedicated",
        node.get("provider") or "local-process",
        node.get("providerConfigRef"),
        node.get("profile") or "standard",
        node.get("sandboxMode") or "boxlite",
        json.dumps(
            node.get("workspacePolicy") or {"kind": "employee-home"},
            sort_keys=True,
            separators=(",", ":"),
        ),
    )


def _canonical_node_rank(node: dict[str, Any]) -> tuple[int, int, str, str]:
    return (
        0 if node.get("activeDaemonNodeId") else 1,
        0 if node.get("phase") == "ready" else 1,
        node.get("createdAt") or "",
        node["id"],
    )


class LocalManagedNodeStore:
    """Durable local-first store for managed-node desired state and attempts."""

    def __init__(self, root_dir: str | Path = DEFAULT_RELAY_DATA_DIR):
        root = Path(root_dir) / "managed-nodes"
        self.nodes_dir = root / "nodes"
        self.attempts_dir = root / "attempts"
        self.grants_dir = root / "enrollment-grants"
        self.slot_lock_path = root / ".policy-slots.lock"
        self._lock = RLock()
        for path in (self.nodes_dir, self.attempts_dir, self.grants_dir):
            path.mkdir(parents=True, exist_ok=True)
        self._reconcile_legacy_duplicate_policy_slots()

    def create_node(
        self, payload: dict[str, Any], *, _policy_slot_locked: bool = False
    ) -> dict[str, Any]:
        assignment_mode = payload.get("assignmentMode") or "dedicated"
        desired_state = payload.get("desiredState") or "running"
        sandbox_mode = payload.get("sandboxMode") or "boxlite"
        if assignment_mode not in MANAGED_NODE_ASSIGNMENT_MODES:
            raise ValueError("assignmentMode must be dedicated.")
        if desired_state not in MANAGED_NODE_DESIRED_STATES:
            raise ValueError("desiredState must be running, stopped, or deleted.")
        _validate_managed_sandbox_mode(sandbox_mode)
        _validate_provider(payload)
        employee_id = _normalize_employee_id(payload.get("employeeId"))
        slot_lock = nullcontext() if _policy_slot_locked else self._policy_slot_lock()
        with self._lock, slot_lock:
            now = now_iso()
            node = {
                "id": str(uuid4()),
                "displayName": payload.get("displayName") or f"Managed node for {employee_id or 'pool'}",
                **({"employeeId": employee_id} if employee_id else {}),
                "assignmentMode": assignment_mode,
                "provider": payload.get("provider") or "local-process",
                **({"providerConfigRef": payload["providerConfigRef"]} if payload.get("providerConfigRef") else {}),
                "profile": payload.get("profile") or "standard",
                "sandboxMode": sandbox_mode,
                "workspacePolicy": payload.get("workspacePolicy") or {"kind": "employee-home"},
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

    @contextmanager
    def _policy_slot_lock(self) -> Iterator[None]:
        with self.slot_lock_path.open("a+", encoding="utf-8") as lock_file:
            fcntl.flock(lock_file.fileno(), fcntl.LOCK_EX)
            try:
                yield
            finally:
                fcntl.flock(lock_file.fileno(), fcntl.LOCK_UN)

    def _reconcile_legacy_duplicate_policy_slots(self) -> None:
        """Retire duplicate active records written before slot uniqueness.

        Creation has enforced one running record per employee/policy slot since
        the invariant was introduced, but existing JSON records predate that
        guard. Leaving those records active makes every backend restart expose
        and provision all of them again. Prefer an already-enrolled runtime;
        otherwise retain the oldest desired record and route the extras through
        the normal managed-node deletion lifecycle.
        """
        with self._lock, self._policy_slot_lock():
            groups: dict[tuple[str, tuple[Any, ...]], list[dict[str, Any]]] = {}
            for node in self.list_nodes():
                if node.get("desiredState") != "running":
                    continue
                raw_employee_id = node.get("employeeId")
                if not isinstance(raw_employee_id, str) or not raw_employee_id.strip():
                    continue
                key = (raw_employee_id.strip(), _managed_node_policy_slot(node))
                groups.setdefault(key, []).append(node)
            for candidates in groups.values():
                if len(candidates) < 2:
                    continue
                canonical = min(candidates, key=_canonical_node_rank)
                for duplicate in candidates:
                    if duplicate["id"] == canonical["id"]:
                        continue
                    self.update_node(
                        duplicate["id"],
                        {"desiredState": "deleted"},
                        _policy_slot_locked=True,
                    )

    def _assert_active_policy_slot_available(
        self, candidate: dict[str, Any], *, exclude_node_id: str | None = None
    ) -> None:
        if candidate.get("desiredState") != "running":
            return
        slot = _managed_node_policy_slot(candidate)
        duplicate = next(
            (
                node
                for node in self.list_nodes()
                if node["id"] != exclude_node_id
                and node.get("desiredState") == "running"
                and node.get("employeeId") == candidate.get("employeeId")
                and _managed_node_policy_slot(node) == slot
            ),
            None,
        )
        if duplicate:
            raise ValueError(
                "Employee already has an active managed node in this policy slot."
            )

    def ensure_node_for_employee(
        self, employee_id: str, *, policy: dict[str, Any] | None = None
    ) -> ManagedCapacityResolution:
        """Return managed capacity and whether provisioning was newly requested."""
        employee_id = employee_id.strip()
        if not employee_id:
            raise ValueError("employeeId is required for managed capacity.")
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
        requested_slot = _managed_node_policy_slot(policy)
        with self._lock, self._policy_slot_lock():
            candidates = [
                node
                for node in self.list_nodes()
                if node.get("employeeId") == employee_id
                and _managed_node_policy_slot(node) == requested_slot
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
                    {"employeeId": employee_id, **policy},
                    _policy_slot_locked=True,
                ),
                True,
            )

    def list_nodes(self, *, include_deleted: bool = False) -> list[dict[str, Any]]:
        nodes = [_read_json(path) for path in self.nodes_dir.glob("*.json")]
        if not include_deleted:
            nodes = [node for node in nodes if node.get("desiredState") != "deleted"]
        return sorted(nodes, key=lambda item: (item.get("createdAt") or "", item["id"]))

    def get_node(self, node_id: str) -> dict[str, Any] | None:
        path = self.nodes_dir / f"{safe_name(node_id)}.json"
        return _read_json(path) if path.exists() else None

    def purge_node(self, node_id: str) -> dict[str, Any]:
        with self._lock:
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
            for path in self.grants_dir.glob("*.json"):
                if _read_json(path).get("attemptId") in attempt_ids:
                    path.unlink()
            for attempt in attempts:
                (self.attempts_dir / f"{safe_name(attempt['id'])}.json").unlink()
            (self.nodes_dir / f"{safe_name(node_id)}.json").unlink()
            return node

    def update_node(
        self,
        node_id: str,
        patch: dict[str, Any],
        *,
        _policy_slot_locked: bool = False,
    ) -> dict[str, Any]:
        slot_lock = nullcontext() if _policy_slot_locked else self._policy_slot_lock()
        with self._lock, slot_lock:
            node = self.get_node(node_id)
            if not node:
                raise KeyError(node_id)
            provider_fields = {"provider", "providerConfigRef", "profile", "sandboxMode", "workspacePolicy"}
            allowed_fields = provider_fields | {
                "displayName",
                "employeeId",
                "assignmentMode",
                "desiredState",
                "phase",
                "conditions",
            }
            unknown = set(patch) - allowed_fields
            if unknown:
                raise ValueError(f"Unsupported managed node field(s): {', '.join(sorted(unknown))}.")
            _validate_provider(patch)
            desired_state = patch.get("desiredState", node["desiredState"])
            if desired_state not in MANAGED_NODE_DESIRED_STATES:
                raise ValueError("desiredState must be running, stopped, or deleted.")
            sandbox_mode = patch.get("sandboxMode", node["sandboxMode"])
            if "sandboxMode" in patch or desired_state == "running":
                _validate_managed_sandbox_mode(sandbox_mode)
            assignment_mode = patch.get("assignmentMode", node["assignmentMode"])
            if (
                "assignmentMode" in patch or desired_state == "running"
            ) and assignment_mode not in MANAGED_NODE_ASSIGNMENT_MODES:
                raise ValueError("assignmentMode must be dedicated.")
            employee_id = patch.get("employeeId", node.get("employeeId"))
            if (
                "employeeId" in patch
                or "assignmentMode" in patch
                or desired_state == "running"
            ) and assignment_mode == "dedicated":
                employee_id = _normalize_employee_id(employee_id)
                patch = {**patch, "employeeId": employee_id}
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
        with self._lock:
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
            expires_at = (datetime.now(timezone.utc) + timedelta(seconds=grant_ttl_seconds)).isoformat().replace("+00:00", "Z")
            grant = {
                "id": grant_id,
                "attemptId": attempt["id"],
                "secretHash": _secret_hash(secret),
                "expiresAt": expires_at,
                "createdAt": now,
            }
            _write_json(self.attempts_dir / f"{safe_name(attempt['id'])}.json", attempt)
            _write_json(self.grants_dir / f"{safe_name(grant_id)}.json", grant)
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
            (self.attempts_dir / f"{safe_name(attempt['id'])}.json").unlink(
                missing_ok=True
            )
        self._sweep_grants({attempt["id"] for attempt in stale})

    def _sweep_grants(self, discarded_attempt_ids: set[str]) -> None:
        """Delete grants that can no longer authorize an enrollment.

        Consumed grants are left to expire on their own so a replayed
        credential still reports why it was refused.
        """
        now = datetime.now(timezone.utc)
        for path in self.grants_dir.glob("*.json"):
            try:
                grant = _read_json(path)
            except (FileNotFoundError, ValueError):
                continue
            expires_at = grant.get("expiresAt")
            expired = bool(expires_at) and _parse_timestamp(expires_at) <= now
            if grant.get("attemptId") in discarded_attempt_ids or expired:
                path.unlink(missing_ok=True)

    def list_attempts(self, node_id: str) -> list[dict[str, Any]]:
        attempts = [_read_json(path) for path in self.attempts_dir.glob("*.json")]
        return sorted(
            (item for item in attempts if item.get("managedNodeId") == node_id),
            key=lambda item: (item.get("startedAt") or "", item["id"]),
        )

    def active_attempt(self, node_id: str) -> dict[str, Any] | None:
        return next((item for item in reversed(self.list_attempts(node_id)) if item.get("status") not in TERMINAL_ATTEMPT_STATUSES), None)

    def update_attempt(self, attempt_id: str, patch: dict[str, Any]) -> dict[str, Any]:
        with self._lock:
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
            _write_json(self.attempts_dir / f"{safe_name(attempt_id)}.json", updated)
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
        with self._lock:
            path = self.grants_dir / f"{safe_name(grant_id)}.json"
            if not path.exists():
                raise PermissionError("Invalid enrollment credential.")
            grant = _read_json(path)
            if grant.get("revokedAt"):
                raise PermissionError("Enrollment grant has been revoked.")
            if grant.get("consumedAt") and not grant.get("daemonNodeId"):
                raise PermissionError("Enrollment grant has already been consumed.")
            if _parse_timestamp(grant["expiresAt"]) <= datetime.now(timezone.utc):
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
        with self._lock:
            path = self.grants_dir / f"{safe_name(grant_id)}.json"
            if not path.exists():
                raise PermissionError("Invalid enrollment credential.")
            grant = _read_json(path)
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
            _write_json(
                path,
                {
                    **grant,
                    "daemonNodeId": daemon_node_id,
                    "consumedAt": grant.get("consumedAt") or now_iso(),
                },
            )

    def complete_enrollment(self, node_id: str, attempt_id: str, daemon_node_id: str) -> tuple[dict[str, Any], dict[str, Any]]:
        with self._lock:
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
        with self._lock:
            node = next((item for item in self.list_nodes() if item.get("activeDaemonNodeId") == daemon_node_id), None)
            if not node or node.get("desiredState") != "running":
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
        path = self.attempts_dir / f"{safe_name(attempt_id)}.json"
        return _read_json(path) if path.exists() else None

    def _write_node(self, node: dict[str, Any]) -> None:
        _write_json(self.nodes_dir / f"{safe_name(node['id'])}.json", node)
