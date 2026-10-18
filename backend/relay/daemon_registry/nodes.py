"""Node registration, identity, liveness, and the live node view.

A mixin of ``DaemonNodeRegistry``: it shares the registry's state and locks
(declared on ``RegistryState``) and is not used on its own.
"""

from __future__ import annotations

import time
from collections import defaultdict
from datetime import datetime
from typing import Any
from loguru import logger
from ..core.computer_identity import computer_id
from ..core.timestamps import iso_epoch_ms
from ..core.ids import now_iso
from ..core.models import (
    AGENT_NAMES,
    DAEMON_NODE_SUPPORTED_PROTOCOL_VERSIONS,
)
from ..persistence.daemon.rules import EXECUTION_INTERRUPTED_STATE_KEY
from ..persistence.stores import (
    infer_node_location,
)
from ..core.daemon_capabilities import (
    DAEMON_NODE_CAPABILITIES,
    client_outdated,
)
from .credentials import (
    daemon_node_token_matches,
    hash_daemon_node_token,
    sandbox_ui_token_matches,
)
from .scheduling import (
    node_accepts_run,
    node_status_for_active_runs,
    normalize_run_capacity,
    workspace_paths_match,
)
from . import config
from .records import (
    DAEMON_NODE_DELETED_STATUS,
    DAEMON_SANDBOX_MODES,
    DeletedDaemonNodeError,
    UnknownDaemonNodeError,
    agent_inventory_state,
    agent_models_state,
    agent_registration_state,
    custom_model_endpoints_state,
    daemon_active_run,
    public_sandbox_record,
)
from .state import RegistryState


def assert_supported_protocol(payload: dict[str, Any]) -> None:
    if payload["protocolVersion"] not in DAEMON_NODE_SUPPORTED_PROTOCOL_VERSIONS:
        raise ValueError(
            f"daemon node protocolVersion {payload['protocolVersion']} is not supported."
        )


def _present(key: str, value: Any) -> dict[str, Any]:
    """`{key: value}` when `value` is truthy, else an empty dict."""
    return {key: value} if value else {}


def registered_capabilities(payload: dict[str, Any]) -> list[str]:
    return sorted(
        {
            value
            for value in (payload.get("capabilities") or [])
            if isinstance(value, str) and value in DAEMON_NODE_CAPABILITIES
        }
    )


def registered_executor_capabilities(payload: dict[str, Any]) -> list[dict[str, Any]]:
    return [
        item
        for item in (payload.get("executorCapabilities") or [])
        if isinstance(item, dict) and item.get("executorKind") in AGENT_NAMES
    ]


def registered_max_concurrent_runs(
    payload: dict[str, Any], existing: dict[str, Any] | None
) -> int:
    """The payload's run capacity, falling back to the prior record's."""
    capacity_input = {
        **(
            {"maxConcurrentRuns": (existing or {}).get("maxConcurrentRuns")}
            if (existing or {}).get("maxConcurrentRuns")
            and "maxConcurrentRuns" not in payload
            else {}
        ),
        **payload,
    }
    return normalize_run_capacity(capacity_input)


def registered_status(payload: dict[str, Any], retired_at: Any) -> str:
    if retired_at:
        return "stopped"
    if payload.get("status") == "busy":
        return "running"
    if payload.get("status") == "stopped":
        return "stopped"
    return "ready"


def _registered_identity_fields(
    payload: dict[str, Any],
    existing: dict[str, Any] | None,
    *,
    user_id: str | None,
    authorized_node_location: str | None,
) -> dict[str, Any]:
    """Ownership, provisioning, workspace, and location fields kept across registrations."""
    prior = existing or {}
    sandbox_mode = payload.get("sandboxMode")
    if sandbox_mode not in DAEMON_SANDBOX_MODES:
        sandbox_mode = prior.get("sandboxMode")
    return {
        **_present("userId", user_id),
        **_present("managedNodeId", prior.get("managedNodeId")),
        **_present("provisioningAttemptId", prior.get("provisioningAttemptId")),
        **(
            {"credentialVersion": prior.get("credentialVersion", 1)}
            if prior.get("managedNodeId")
            else {}
        ),
        **_present("workspacePath", payload.get("workspacePath")),
        **_present(
            "workspaceId", payload.get("workspaceId") or prior.get("workspaceId")
        ),
        **_present("enrollmentKey", prior.get("enrollmentKey")),
        **_present("sandboxMode", sandbox_mode),
        **_present(
            "nodeLocation", prior.get("nodeLocation") or authorized_node_location
        ),
    }


def _registered_agent_fields(payload: dict[str, Any]) -> dict[str, Any]:
    """Agent inventory reported in the payload."""
    agents, agent_details = agent_registration_state(payload)
    executor_capabilities = registered_executor_capabilities(payload)
    agent_inventory = agent_inventory_state(payload)
    custom_model_endpoints = custom_model_endpoints_state(payload)
    agent_models = agent_models_state(payload)
    return {
        "agents": agents,
        **_present("executorCapabilities", executor_capabilities),
        **_present("agentDetails", agent_details),
        **_present("agentInventory", agent_inventory),
        **_present("customModelEndpoints", custom_model_endpoints),
        **_present("agentModels", agent_models),
    }


def _registered_agent_settings(existing: dict[str, Any] | None) -> dict[str, Any]:
    """Admin agent settings carried over from the prior record."""
    prior = existing or {}
    return {
        **_present("disabledAgents", list(prior.get("disabledAgents") or [])),
        **_present("agentRoleDefaults", dict(prior.get("agentRoleDefaults") or {})),
        **_present("agentRoleOverrides", dict(prior.get("agentRoleOverrides") or {})),
    }


def registered_node_record(
    payload: dict[str, Any],
    existing: dict[str, Any] | None,
    *,
    user_id: str | None,
    display_name: str | None,
    ui_token_hash: str | None,
    authorized_node_location: str | None,
    now: str,
) -> dict[str, Any]:
    """The node record a registration writes, built from the payload and prior record."""
    prior = existing or {}
    agent_fields = _registered_agent_fields(payload)
    retired_at = prior.get("retiredAt")
    max_concurrent_runs = registered_max_concurrent_runs(payload, existing)
    return {
        "id": payload["sandboxId"],
        **_registered_identity_fields(
            payload,
            existing,
            user_id=user_id,
            authorized_node_location=authorized_node_location,
        ),
        "capabilities": registered_capabilities(payload),
        "status": registered_status(payload, retired_at),
        **agent_fields,
        **_present("displayName", display_name),
        **_registered_agent_settings(existing),
        **_present("retiredAt", retired_at),
        "maxConcurrentRuns": max_concurrent_runs,
        "uiTokenHash": ui_token_hash,
        "nodeTokenHash": hash_daemon_node_token(payload.get("token"))
        or prior.get("nodeTokenHash"),
        "createdAt": prior.get("createdAt", now),
        "updatedAt": now,
        "lastSeenAt": now,
    }



class NodeRegistrationMixin(RegistryState):
    def register(
        self,
        payload: dict[str, Any],
        ui_token: str | None = None,
        *,
        authorized_node_location: str | None = None,
    ) -> dict[str, Any]:
        self._refresh_persisted_liveness(payload["sandboxId"])
        with self.dispatch_scope([payload["sandboxId"]]):
            return self._register_unlocked(
                payload,
                ui_token,
                authorized_node_location=authorized_node_location,
            )

    def _register_unlocked(
        self,
        payload: dict[str, Any],
        ui_token: str | None,
        *,
        authorized_node_location: str | None = None,
    ) -> dict[str, Any]:
        assert_supported_protocol(payload)
        now = now_iso()
        existing = self.sandboxes.get(payload["sandboxId"])
        self._assert_registration_allowed(payload, existing)
        user_id = (
            (existing or {}).get("userId")
            if existing
            else payload.get("userId")
        )
        next_ui_hash = (
            hash_daemon_node_token(ui_token)
            if ui_token
            else (existing or {}).get("uiTokenHash")
        )
        sandbox = registered_node_record(
            payload,
            existing,
            user_id=user_id,
            display_name=self._registration_display_name(payload, user_id, existing),
            ui_token_hash=next_ui_hash,
            authorized_node_location=authorized_node_location,
            now=now,
        )
        self._persist_registered_node(sandbox, payload)
        logger.info(
            "Daemon node registered",
            sandbox_id=sandbox["id"],
            user_id=sandbox.get("userId"),
            status=sandbox["status"],
            agents={agent: status for agent, status in sandbox["agents"].items()},
        )
        return sandbox

    def _assert_registration_allowed(
        self, payload: dict[str, Any], existing: dict[str, Any] | None
    ) -> None:
        # A deleted node must stay deleted. Without this the daemon that was
        # still running on the machine simply re-registers itself seconds after
        # an admin deletes it, and the node reappears in the Admin Console.
        # Re-enrolling the same machine is still possible: the admin provisions
        # a fresh record first, and registration then finds a live `existing`.
        if not self._live_node(payload["sandboxId"]):
            tombstone = self._deleted_tombstone(payload)
            if tombstone:
                logger.warning(
                    "Rejected registration for a deleted daemon node",
                    sandbox_id=payload["sandboxId"],
                    tombstone_id=tombstone["id"],
                )
                raise DeletedDaemonNodeError(
                    f"Daemon node {payload['sandboxId']} was deleted in the Admin Console. "
                    "Stop this daemon, or re-enroll the machine from the Admin Console."
                )
        if (
            existing and existing.get("nodeTokenHash")
        ) and not daemon_node_token_matches(existing, payload["token"]):
            logger.warning(
                "Unauthorized daemon node registration", sandbox_id=payload["sandboxId"]
            )
            raise PermissionError(
                f"Unauthorized daemon node registration for {payload['sandboxId']}: token does not match the token issued at provisioning."
            )

    def _persist_registered_node(
        self, sandbox: dict[str, Any], payload: dict[str, Any]
    ) -> None:
        retired_at = sandbox.get("retiredAt")
        self.sandboxes[sandbox["id"]] = sandbox
        self._remember_control_panel_node_token(sandbox, payload.get("token"))
        # Retire the superseded rows before inserting, or the new incarnation
        # collides with them on uq_daemon_nodes_computer.
        if not retired_at:
            self._retire_superseded_incarnations(sandbox)
        self.daemon_store.register_node(sandbox)
        for command in payload.get("runtimeRefreshCommands") or []:
            self.daemon_store.complete_runtime_refresh(sandbox["id"], command)
        if not retired_at:
            try:
                self.rehome_workspace_cleanups(computer_id(sandbox), sandbox["id"])
            except Exception:  # noqa: BLE001 - best-effort side effect; logged, retried by the next pass
                # Cleanup stays queued on the retired node; the next registration retries.
                logger.exception("Failed to move project cleanup", sandbox_id=sandbox["id"])

    def account_journaled_commands(
        self, sandbox_id: str, command_ids: list[str]
    ) -> list[str]:
        """Record runs a restarted daemon admitted but will not resume.

        The daemon journals each run.start before executing it and refuses to
        run a journaled command again after a crash. Its report is not exit
        evidence -- a host-mode agent may outlive its daemon -- so a still
        delivered run is only marked interrupted, which a person can then
        report gone. Returns the ids this node may forget: all of them. Only
        this node's still-delivered runs are marked; the rest change nothing.
        """
        acknowledged: list[str] = []
        with self.dispatch_scope([sandbox_id]):
            for command_id in command_ids[:config.JOURNAL_REPORT_LIMIT]:
                record = self.daemon_store.get_command(command_id)
                if not record:
                    acknowledged.append(command_id)
                    continue
                if record.get("nodeId") != sandbox_id:
                    logger.warning(
                        "Ignored a journaled run that belongs to another node",
                        node_id=sandbox_id, command_id=command_id,
                    )
                    acknowledged.append(command_id)
                    continue
                if record.get("status") == "dispatched":
                    request = self.daemon_store.run_request_for_command(command_id)
                    if request and self.daemon_store.mark_run_request_state(
                        request["id"], EXECUTION_INTERRUPTED_STATE_KEY
                    ):
                        logger.warning(
                            "Daemon restarted with a run it will not resume",
                            node_id=sandbox_id, command_id=command_id,
                            run_id=(record.get("command") or {}).get("runId"),
                        )
                acknowledged.append(command_id)
        return acknowledged

    def _live_node(self, sandbox_id: str) -> dict[str, Any] | None:
        """The node row for `sandbox_id`, unless it is a deletion tombstone."""
        node = self.sandboxes.get(sandbox_id)
        if not node or node.get("status") == DAEMON_NODE_DELETED_STATUS:
            return None
        return node

    def _deleted_tombstone(self, payload: dict[str, Any]) -> dict[str, Any] | None:
        """A deletion tombstone matching the Computer this payload comes from.

        Matches on the node id and, for user devices, on the workspace
        identity -- a restarted daemon comes back with a fresh sandboxId but
        the same machine, and deleting a node has to survive that restart.
        """
        by_id = self.sandboxes.get(payload["sandboxId"])
        if by_id and by_id.get("status") == DAEMON_NODE_DELETED_STATUS:
            return by_id
        workspace_id = payload.get("workspaceId")
        if not workspace_id:
            return None
        for node in self.sandboxes.values():
            if (
                node.get("status") == DAEMON_NODE_DELETED_STATUS
                and not node.get("managedNodeId")
                and node.get("workspaceId") == workspace_id
            ):
                return node
        return None

    def _superseded_incarnations(self, sandbox: dict[str, Any]) -> list[dict[str, Any]]:
        """Live node rows describing the same Computer as `sandbox`.

        Identity always goes through `core.computer_identity.computer_id` —
        do not reimplement it inline here. A node whose identity cannot be
        resolved (falling back to `node:<id>`) matches only itself, so it can
        never retire someone else's node by accident.
        """
        identity = computer_id(sandbox)
        if identity == f"node:{sandbox['id']}":
            return []
        return [
            node
            for node in self.sandboxes.values()
            if node["id"] != sandbox["id"]
            and not node.get("retiredAt")
            and computer_id(node) == identity
        ]

    def _retire_superseded_incarnations(self, sandbox: dict[str, Any]) -> None:
        for node in self._superseded_incarnations(sandbox):
            retired_at = now_iso()
            self.sandboxes[node["id"]] = {
                **node,
                "retiredAt": retired_at,
                "status": "stopped",
                "updatedAt": retired_at,
            }
            self.daemon_store.mark_node_seen(
                node["id"], {"retiredAt": retired_at, "status": "stopped"}
            )
            logger.info(
                "Retired superseded daemon node incarnation",
                sandbox_id=node["id"],
                superseded_by=sandbox["id"],
                user_id=node.get("userId"),
                workspace_id=node.get("workspaceId"),
            )

    def computer_node_records(self, computer: str) -> list[dict[str, Any]]:
        """Every node record of one computer, retired incarnations and tombstones included."""
        return [node for node in self.sandboxes.values() if computer_id(node) == computer]

    def _registration_display_name(
        self,
        payload: dict[str, Any],
        user_id: str | None,
        existing: dict[str, Any] | None,
    ) -> str | None:
        if existing is not None:
            display_name = existing.get("displayName")
            return str(display_name) if display_name else None
        workspace_id = payload.get("workspaceId")
        if not user_id or not workspace_id:
            return None
        matches = [
            node
            for node in self.sandboxes.values()
            if node["id"] != payload["sandboxId"]
            and node.get("userId") == user_id
            and node.get("workspaceId") == workspace_id
            and not node.get("managedNodeId")
        ]
        if not matches:
            return None
        matches.sort(
            key=lambda node: node.get("updatedAt") or node.get("createdAt") or "",
            reverse=True,
        )
        display_name = matches[0].get("displayName")
        return str(display_name) if display_name else None

    def get(self, sandbox_id: str) -> dict[str, Any] | None:
        if sandbox_id not in self.sandboxes:
            self._refresh_persisted_liveness(sandbox_id)
        # A deletion tombstone is bookkeeping, not a node: callers that look a
        # node up to act on it must see it as gone.
        return self._live_node(sandbox_id)

    def list_ready(self) -> list[dict[str, Any]]:
        self._refresh_persisted_liveness()
        if not self.sandboxes:
            return []
        active_runs_by_node = self._active_runs_by_node()
        return sorted(
            self.sandboxes.values(),
            key=lambda sandbox: self._selection_key(
                sandbox, active_runs_by_node.get(sandbox["id"], [])
            ),
        )

    def update_status(self, sandbox_id: str, patch: dict[str, Any]) -> None:
        sandbox = self.sandboxes.get(sandbox_id)
        if not sandbox:
            return
        next_patch = {k: v for k, v in patch.items() if v is not None}
        if sandbox.get("retiredAt"):
            next_patch["status"] = "stopped"
        if next_patch.get("status") in ("ready", "running"):
            next_patch["status"] = node_status_for_active_runs(
                {**sandbox, **next_patch},
                self.daemon_store.list_active_runs(sandbox_id),
            )
        status = next_patch.get("status", sandbox.get("status"))
        updated = {**sandbox, **next_patch, "updatedAt": now_iso()}
        if "lastError" in patch and patch["lastError"] is None:
            updated.pop("lastError", None)
        self.sandboxes[sandbox_id] = updated
        self.daemon_store.mark_node_seen(sandbox_id, patch)
        logger.debug("Daemon node status updated", sandbox_id=sandbox_id, status=status)

    def monitor_nodes(self) -> list[dict[str, Any]]:

        self._refresh_persisted_liveness()
        active_runs_by_node = self._active_runs_by_node()
        queued_counts = self.daemon_store.queued_command_counts()
        nodes = []
        for sandbox in sorted(
            self.sandboxes.values(),
            key=lambda item: self._selection_key(
                item, active_runs_by_node.get(item["id"], [])
            ),
        ):
            if sandbox.get("status") == DAEMON_NODE_DELETED_STATUS:
                continue
            liveness = self._liveness(sandbox)
            nodes.append(
                {
                    **public_sandbox_record(sandbox),
                    "queuedCommandCount": queued_counts.get(sandbox["id"], 0),
                    "activeRuns": [
                        daemon_active_run(run)
                        for run in active_runs_by_node.get(sandbox["id"], [])
                    ],
                    "online": liveness["online"],
                    "stale": liveness["stale"],
                    "clientOutdated": client_outdated(sandbox),
                    **(
                        {"lastSeenAgeMs": liveness["lastSeenAgeMs"]}
                        if "lastSeenAgeMs" in liveness
                        else {}
                    ),
                }
            )
        return nodes

    def monitor_nodes_for_token(self, token: str | None) -> list[dict[str, Any]] | None:
        if not token:
            return None
        allowed = {
            sandbox["id"]
            for sandbox in self.sandboxes.values()
            if sandbox_ui_token_matches(sandbox, token)
        }
        if not allowed:
            return None
        return [node for node in self.monitor_nodes() if node["id"] in allowed]

    def control_panel_nodes(self) -> list[dict[str, Any]]:
        nodes = self.monitor_nodes()
        for node in nodes:
            plain = self.plain_node_tokens.get(node["id"])
            if plain:
                node["nodeToken"] = plain
        return nodes

    def count_user_device_nodes(self, user_id: str) -> int:
        """Live personal computers owned by a user.

        Deleted nodes are excluded: a tombstone is a computer the user no
        longer has, so it must not consume a slot in their limit.
        """
        self._refresh_persisted_liveness()
        return sum(
            1
            for sandbox in self.sandboxes.values()
            if sandbox.get("userId") == user_id
            and sandbox.get("status") != DAEMON_NODE_DELETED_STATUS
            and not sandbox.get("retiredAt")
            and infer_node_location(sandbox) == "user-device"
        )

    def find_by_user(
        self, user_id: str, workspace_path: str | None = None
    ) -> dict[str, Any] | None:
        self._refresh_persisted_liveness()
        matches = [
            sandbox
            for sandbox in self.sandboxes.values()
            if sandbox.get("userId") == user_id
            and sandbox.get("status") != DAEMON_NODE_DELETED_STATUS
            and (
                not workspace_path
                or not sandbox.get("workspacePath")
                or workspace_paths_match(sandbox.get("workspacePath"), workspace_path)
            )
        ]
        if not matches:
            return None
        active_runs_by_node = self._active_runs_by_node()
        return min(
            matches,
            key=lambda sandbox: self._selection_key(
                sandbox, active_runs_by_node.get(sandbox["id"], [])
            ),
        )

    def _active_runs_by_node(self) -> dict[str, list[dict[str, Any]]]:
        active_runs_by_node: dict[str, list[dict[str, Any]]] = defaultdict(list)
        for run in self.daemon_store.list_active_runs():
            active_runs_by_node[run["nodeId"]].append(run)
        return active_runs_by_node

    def _selection_key(
        self, sandbox: dict[str, Any], active_runs: list[dict[str, Any]]
    ) -> tuple[int, int, float, str]:
        liveness = self._liveness(sandbox)
        timestamp = (
            sandbox.get("lastSeenAt")
            or sandbox.get("updatedAt")
            or sandbox.get("createdAt")
            or ""
        )
        try:
            seen_at = datetime.fromisoformat(
                timestamp.replace("Z", "+00:00")
            ).timestamp()
        except ValueError:
            seen_at = 0.0
        return (
            0
            if liveness["online"] and node_accepts_run(sandbox, active_runs=active_runs)
            else 1,
            0 if liveness["online"] else 1,
            -seen_at,
            sandbox["id"],
        )

    def is_live(self, sandbox_id: str) -> bool:
        self._refresh_persisted_liveness(sandbox_id)
        sandbox = self.sandboxes.get(sandbox_id)
        return bool(sandbox and self._liveness(sandbox)["online"])

    def assert_node_authenticated(self, sandbox_id: str, token: str | None) -> None:
        """Validate a runtime token without renewing liveness or changing node state."""
        self._hydrate_node(sandbox_id)
        with self.dispatch_scope([sandbox_id]):
            self._assert_authorized(sandbox_id, token)

    def assert_node_event_authorized(self, sandbox_id: str, token: str | None) -> None:
        """Authorize non-run events without attempting run-event bookkeeping."""
        self._hydrate_node(sandbox_id)
        with self.dispatch_scope([sandbox_id]):
            self._assert_authorized(sandbox_id, token)
            self._mark_seen(sandbox_id)

    def _age_ms(self, iso_timestamp: str) -> int:
        seen_ms = iso_epoch_ms(iso_timestamp)
        if seen_ms is None:
            logger.warning(
                "Failed to parse timestamp for age calculation",
                iso_timestamp=iso_timestamp,
            )
            return 0
        return max(0, int(time.time() * 1000 - seen_ms))

    def _hydrate_node(self, sandbox_id: str) -> None:
        """Load cross-replica state before entering an authenticated node scope."""
        if sandbox_id not in self.sandboxes:
            self._refresh_persisted_liveness(sandbox_id)

    def _assert_authorized(self, sandbox_id: str, token: str | None) -> None:
        sandbox = self.sandboxes.get(sandbox_id)
        if not sandbox:
            logger.warning(
                "Daemon node request for unknown sandbox", sandbox_id=sandbox_id
            )
            raise UnknownDaemonNodeError(f"Unknown sandbox {sandbox_id}.")
        if not daemon_node_token_matches(sandbox, token):
            logger.warning("Unauthorized daemon node request", sandbox_id=sandbox_id)
            raise PermissionError("Unauthorized daemon node request.")
        if sandbox.get("status") == DAEMON_NODE_DELETED_STATUS:
            raise DeletedDaemonNodeError(
                f"Daemon node {sandbox_id} was deleted in the Admin Console."
            )

    def _should_persist_seen(self, sandbox_id: str) -> bool:
        """Rate-limit durable heartbeat writes under the node dispatch scope."""
        monotonic_now = time.monotonic()
        last = self._last_seen_persisted_at.get(sandbox_id)
        if (
            last is not None
            and monotonic_now - last < config.DAEMON_NODE_SEEN_PERSIST_INTERVAL_SECONDS
        ):
            return False
        self._last_seen_persisted_at[sandbox_id] = monotonic_now
        return True

    def _mark_seen(self, sandbox_id: str) -> None:
        with self.dispatch_scope([sandbox_id]):
            sandbox = self.sandboxes.get(sandbox_id)
            if not sandbox:
                return
            revived = not sandbox.get("retiredAt") and sandbox["status"] in (
                "stopped",
                "provisioning",
                "failed",
            )
            patch = {"status": "ready", "lastError": None} if revived else {}
            now = now_iso()
            updated = {
                **sandbox,
                **{k: v for k, v in patch.items() if v is not None},
                "updatedAt": now,
                "lastSeenAt": now,
            }
            if "lastError" in patch and patch["lastError"] is None:
                updated.pop("lastError", None)
            self.sandboxes[sandbox_id] = updated
            # An idle long poll calls this several times per second per node.
            # The in-memory view above stays exact for this replica's liveness
            # checks; the durable write is throttled well inside the liveness
            # timeout so other replicas still see the node as online.
            if revived or self._should_persist_seen(sandbox_id):
                self.daemon_store.mark_node_seen(sandbox_id, patch)
            if revived:
                logger.info(
                    "Daemon node came online",
                    sandbox_id=sandbox_id,
                    previous_status=sandbox["status"],
                )

    def _load_persisted_state(self) -> None:
        nodes = self.daemon_store.list_nodes()
        if nodes:
            logger.info("Loaded persisted daemon nodes", count=len(nodes))
        active_runs = self.daemon_store.list_active_runs()
        active_node_ids = {run["nodeId"] for run in active_runs}
        for sandbox in nodes:
            node_location = infer_node_location(sandbox)
            waiting_status = (
                # A deletion tombstone stays deleted across backend restarts,
                # or the daemon on that machine resurrects the node.
                DAEMON_NODE_DELETED_STATUS
                if sandbox.get("status") == DAEMON_NODE_DELETED_STATUS
                else "stopped"
                if sandbox.get("retiredAt")
                else "running"
                if sandbox["id"] in active_node_ids
                else "provisioning"
                if sandbox.get("status") == "provisioning"
                else "stopped"
            )
            self.sandboxes[sandbox["id"]] = {
                **sandbox,
                **({"nodeLocation": node_location} if node_location else {}),
                "status": waiting_status,
                # A successful authenticated command poll proves that the same
                # daemon identity is live again. Keep its last registered
                # capability state during backend recovery so liveness cannot
                # become ready while every Logical Agent stays unavailable
                # until the daemon's next periodic registration.
                "agents": (
                    {agent: "unknown" for agent in AGENT_NAMES}
                    if sandbox.get("retiredAt")
                    else {
                        agent: (sandbox.get("agents") or {}).get(agent, "unknown")
                        for agent in AGENT_NAMES
                    }
                ),
                "updatedAt": now_iso(),
                "lastError": sandbox.get("lastError")
                or "Waiting for daemon node registration.",
            }
        for run in active_runs:
            self.active_commands[run["commandId"]] = {**run, "sandboxId": run["nodeId"]}

    def _refresh_persisted_liveness(self, sandbox_id: str | None = None) -> None:
        """Merge newer durable lease observations from another backend replica."""
        with self.dispatch_lock:
            persisted_nodes = (
                [self.daemon_store.get_node(sandbox_id)]
                if sandbox_id
                else self.daemon_store.list_nodes()
            )
            for persisted in persisted_nodes:
                if not persisted:
                    continue
                current = self.sandboxes.get(persisted["id"])
                if not current:
                    node_location = infer_node_location(persisted)
                    self.sandboxes[persisted["id"]] = {
                        **persisted,
                        **({"nodeLocation": node_location} if node_location else {}),
                        "agents": {
                            agent: (persisted.get("agents") or {}).get(agent, "unknown")
                            for agent in AGENT_NAMES
                        },
                    }
                    continue
                persisted_seen = persisted.get("lastSeenAt") or ""
                current_seen = current.get("lastSeenAt") or ""
                refreshed = {
                    **current,
                    **persisted,
                    "lastSeenAt": max(persisted_seen, current_seen),
                    "updatedAt": max(
                        persisted.get("updatedAt") or "",
                        current.get("updatedAt") or "",
                    ),
                }
                if persisted.get("retiredAt"):
                    refreshed["agents"] = current.get("agents", refreshed.get("agents"))
                if current_seen >= persisted_seen and not persisted.get("retiredAt"):
                    refreshed["status"] = current.get("status", persisted.get("status"))
                    if current.get("lastError"):
                        refreshed["lastError"] = current["lastError"]
                    else:
                        refreshed.pop("lastError", None)
                self.sandboxes[persisted["id"]] = refreshed

    def _liveness(self, sandbox: dict[str, Any]) -> dict[str, Any]:
        if sandbox.get("status") == "stopped" or not sandbox.get("lastSeenAt"):
            return {"online": False, "stale": True}
        seen_ms = iso_epoch_ms(sandbox["lastSeenAt"])
        if seen_ms is None:
            logger.warning(
                "Failed to parse lastSeenAt for sandbox liveness",
                sandbox_id=sandbox.get("id"),
                last_seen=sandbox.get("lastSeenAt"),
            )
            return {"online": False, "stale": True}
        age = max(0, int(time.time() * 1000 - seen_ms))
        online = age <= self.liveness_timeout_ms
        if not online:
            logger.debug(
                "Daemon node stale", sandbox_id=sandbox["id"], last_seen_age_ms=age
            )
        return {"online": online, "stale": not online, "lastSeenAgeMs": age}
