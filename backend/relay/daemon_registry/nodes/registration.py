"""Node registration and identity: admitting a daemon, its record, and its superseded incarnations.

A mixin of ``DaemonNodeRegistry``: it shares the registry's state and locks
(declared on ``RegistryState``) and is not used on its own.
"""

from __future__ import annotations

from typing import Any
from loguru import logger
from ...core.computer_identity import computer_id
from ...core.ids import now_iso
from ...core.models import (
    AGENT_NAMES,
    DAEMON_NODE_SUPPORTED_PROTOCOL_VERSIONS,
)
from ...core.daemon_records import EXECUTION_INTERRUPTED_STATE_KEY, NODE_POLL_DRAINED_AT
from ...core.daemon_capabilities import (
    DAEMON_NODE_CAPABILITIES,
)
from ..credentials import (
    daemon_node_token_matches,
    hash_daemon_node_token,
)
from ..scheduling import (
    normalize_run_capacity,
)
from .. import config
from ..records import (
    DAEMON_NODE_DELETED_STATUS,
    DAEMON_SANDBOX_MODES,
    DeletedDaemonNodeError,
    agent_inventory_state,
    agent_models_state,
    agent_registration_state,
    custom_model_endpoints_state,
    host_os_state,
)
from ..state import RegistryState



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
        # An older daemon reports no OS; keep what an earlier one said.
        **_present("hostOs", host_os_state(payload) or prior.get("hostOs")),
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
        # A registration says nothing about polling; see preserve_node_poll.
        # A drain pin is the exception: the daemon that drained is gone, and
        # the one registering now will poll, so it gets the benefit of the
        # doubt a never-polled node has.
        **_present("lastPollAt", _poll_after_registration(prior.get("lastPollAt"))),
    }


def _poll_after_registration(last_poll_at: Any) -> Any:
    return None if last_poll_at == NODE_POLL_DRAINED_AT else last_poll_at



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
        self.assert_not_deleted(payload)
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

    def assert_not_deleted(self, payload: dict[str, Any]) -> None:
        """Refuse a registration from a Computer an admin deleted."""
        if self._live_node(payload["sandboxId"]):
            return
        tombstone = self._deleted_tombstone(payload)
        if not tombstone:
            return
        logger.warning(
            "Rejected registration for a deleted daemon node",
            sandbox_id=payload["sandboxId"],
            tombstone_id=tombstone["id"],
        )
        raise DeletedDaemonNodeError(
            f"Daemon node {payload['sandboxId']} was deleted in the Admin Console. "
            "Stop this daemon, or re-enroll the machine from the Admin Console."
        )

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
