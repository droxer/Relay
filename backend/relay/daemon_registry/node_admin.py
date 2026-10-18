"""Administrative changes to nodes: tokens, user assignment, agent settings, deletion, provisioning, enrollment, and workspace-cleanup rehoming.

A mixin of ``DaemonNodeRegistry``: it shares the registry's state and locks
(declared on ``RegistryState``) and is not used on its own.
"""

from __future__ import annotations

from typing import Any
from loguru import logger
from ..core.computer_identity import computer_id, local_enrollment_key
from ..core.ids import new_database_id, new_sandbox_id, now_iso
from ..core.models import (
    AGENT_NAMES,
)
from .credentials import (
    daemon_node_token_matches,
    hash_daemon_node_token,
    managed_daemon_node_token,
    new_daemon_node_token,
)
from .scheduling import (
    normalize_agent_role_map,
)
from .records import (
    DAEMON_NODE_DELETED_STATUS,
    DAEMON_SANDBOX_MODES,
    WORKSPACE_DELETE_COMMAND,
    cleanup_node_rank,
)
from .state import RegistryState


class NodeAdministrationMixin(RegistryState):
    def live_cleanup_node(self, computer: str) -> dict[str, Any] | None:
        """The computer's live node best placed to run project cleanup."""
        live = [
            node for node in self.monitor_nodes()
            if computer_id(node) == computer and not node.get("retiredAt")
        ]
        return min(live, key=cleanup_node_rank, default=None)

    def rehome_workspace_cleanups(self, computer: str, target_id: str) -> int:
        """Hand project cleanup queued on a computer's retired nodes to `target_id`.

        Project deletion queues `workspace.delete` on whichever node record the
        computer still has, retired ones included, because the files outlive any
        one incarnation. A retired node never polls again, so the work moves to
        the live node when one exists. The copy is queued before the original is
        closed: a crash in between leaves an undeliverable duplicate on the
        retired node, never a lost cleanup.
        """
        moved = 0
        for node in self.computer_node_records(computer):
            if node["id"] == target_id or not node.get("retiredAt"):
                continue
            for record in self.daemon_store.pending_commands_of_type(
                node["id"], WORKSPACE_DELETE_COMMAND
            ):
                command = {
                    key: value for key, value in record["command"].items()
                    if key != "id" and not key.startswith("_")
                }
                try:
                    self.daemon_store.enqueue_command(
                        target_id, {**command, "id": new_database_id()}
                    )
                except ValueError:
                    logger.warning(
                        "Deferred moving project cleanup; target command queue is full",
                        command_id=record["id"], target_node_id=target_id,
                    )
                    return moved
                self.daemon_store.retire_command(
                    record["id"], f"Cleanup moved to daemon node {target_id}."
                )
                moved += 1
        if moved:
            logger.info(
                "Moved project cleanup to live daemon node",
                computer_id=computer, target_node_id=target_id, commands=moved,
            )
        return moved

    def reveal_node_token(self, sandbox_id: str) -> str | None:
        """Retained for older clients: launch credentials are now hash-only."""
        if not self._live_node(sandbox_id):
            raise KeyError(sandbox_id)
        return None

    def reissue_node_token(self, sandbox_id: str) -> tuple[dict[str, Any], str]:
        """Rotate a live node's launch token and return the new plaintext once.

        The old token stops authenticating as soon as the new hash lands, so a
        daemon still running with it must be restarted with the reissued one.
        """
        with self.dispatch_scope([sandbox_id]):
            sandbox = self._live_node(sandbox_id)
            if not sandbox:
                raise KeyError(sandbox_id)
            if sandbox.get("managedNodeId"):
                raise ValueError(
                    "Managed node credentials are rotated by the managed node lifecycle."
                )
            node_token = new_daemon_node_token()
            updated = {
                **sandbox,
                "nodeTokenHash": hash_daemon_node_token(node_token),
                "credentialVersion": int(sandbox.get("credentialVersion") or 1) + 1,
                "updatedAt": now_iso(),
            }
            self.sandboxes[sandbox_id] = updated
            self.daemon_store.register_node(updated)
            self.plain_node_tokens[sandbox_id] = node_token
            logger.info("Daemon node token reissued", sandbox_id=sandbox_id)
            return updated, node_token

    def assign_user(self, sandbox_id: str, user_id: str) -> dict[str, Any]:
        sandbox = self.sandboxes.get(sandbox_id)
        if not sandbox:
            raise KeyError(sandbox_id)
        if sandbox.get("userId"):
            raise ValueError("Daemon node is already assigned.")
        persisted = self.daemon_store.assign_node_user(sandbox_id, user_id)
        updated = {**sandbox, **persisted}
        self.sandboxes[sandbox_id] = updated
        logger.info(
            "Daemon node assigned", sandbox_id=sandbox_id, user_id=user_id
        )
        return updated

    def unassign_user_everywhere(self, user_id: str) -> list[str]:
        affected: list[str] = []
        for sandbox_id, sandbox in list(self.sandboxes.items()):
            if sandbox.get("userId") == user_id:
                self.unassign_user(sandbox_id)
                affected.append(sandbox_id)
        return affected

    def unassign_user(self, sandbox_id: str) -> dict[str, Any]:
        sandbox = self.sandboxes.get(sandbox_id)
        if not sandbox:
            raise KeyError(sandbox_id)
        if not sandbox.get("userId"):
            raise ValueError("Daemon node is not assigned.")
        previous = sandbox["userId"]
        updated = {
            k: v
            for k, v in sandbox.items()
            if k not in ("userId", "agentRoleOverrides")
        }
        updated["updatedAt"] = now_iso()
        self.sandboxes[sandbox_id] = updated
        self.daemon_store.unassign_node_user(sandbox_id)
        logger.info(
            "Daemon node unassigned",
            sandbox_id=sandbox_id,
            previous_user_id=previous,
        )
        return updated

    def set_disabled_agents(
        self, sandbox_id: str, disabled_agents: list[str]
    ) -> dict[str, Any]:
        sandbox = self.sandboxes.get(sandbox_id)
        if not sandbox:
            raise KeyError(sandbox_id)
        invalid = [name for name in disabled_agents if name not in AGENT_NAMES]
        if invalid:
            raise ValueError(f"Unknown agent name(s): {', '.join(invalid)}.")
        normalized = sorted({name for name in disabled_agents})
        updated = {**sandbox, "disabledAgents": normalized, "updatedAt": now_iso()}
        if not normalized:
            updated.pop("disabledAgents", None)
        self.sandboxes[sandbox_id] = updated
        self.daemon_store.update_node_disabled_agents(sandbox_id, normalized)
        logger.info(
            "Daemon node disabled agents updated",
            sandbox_id=sandbox_id,
            disabled_agents=normalized,
        )
        return updated

    def set_display_name(
        self, sandbox_id: str, display_name: str | None
    ) -> dict[str, Any]:
        sandbox = self.sandboxes.get(sandbox_id)
        if not sandbox:
            raise KeyError(sandbox_id)
        updated = {**sandbox, "updatedAt": now_iso()}
        if display_name:
            updated["displayName"] = display_name
        else:
            updated.pop("displayName", None)
        self.sandboxes[sandbox_id] = updated
        self.daemon_store.update_node_display_name(sandbox_id, display_name)
        logger.info(
            "Daemon node display name updated",
            sandbox_id=sandbox_id,
            display_name=display_name,
        )
        return updated

    def fence_managed_node(self, sandbox_id: str) -> dict[str, Any]:
        sandbox = self.sandboxes.get(sandbox_id)
        if not sandbox:
            raise KeyError(sandbox_id)
        retired_at = now_iso()
        updated = {
            **sandbox,
            "retiredAt": retired_at,
            "status": "stopped",
            "updatedAt": retired_at,
        }
        self.sandboxes[sandbox_id] = updated
        self.daemon_store.mark_node_seen(
            sandbox_id, {"retiredAt": retired_at, "status": "stopped"}
        )
        return updated

    def set_agent_role_defaults(
        self, sandbox_id: str, role_defaults: dict[str, str]
    ) -> dict[str, Any]:
        sandbox = self.sandboxes.get(sandbox_id)
        if not sandbox:
            raise KeyError(sandbox_id)
        normalized = normalize_agent_role_map(role_defaults)
        updated = {**sandbox, "agentRoleDefaults": normalized, "updatedAt": now_iso()}
        if not normalized:
            updated.pop("agentRoleDefaults", None)
        self.sandboxes[sandbox_id] = updated
        self.daemon_store.update_node_agent_role_defaults(sandbox_id, normalized)
        logger.info(
            "Daemon node agent role defaults updated",
            sandbox_id=sandbox_id,
            agent_role_defaults=normalized,
        )
        return updated

    def set_agent_role_overrides(
        self, sandbox_id: str, role_overrides: dict[str, str]
    ) -> dict[str, Any]:
        sandbox = self.sandboxes.get(sandbox_id)
        if not sandbox:
            raise KeyError(sandbox_id)
        normalized = normalize_agent_role_map(role_overrides)
        updated = {**sandbox, "agentRoleOverrides": normalized, "updatedAt": now_iso()}
        if not normalized:
            updated.pop("agentRoleOverrides", None)
        self.sandboxes[sandbox_id] = updated
        self.daemon_store.update_node_agent_role_overrides(sandbox_id, normalized)
        logger.info(
            "Daemon node agent role overrides updated",
            sandbox_id=sandbox_id,
            agent_role_overrides=normalized,
        )
        return updated

    def delete(self, sandbox_id: str) -> None:
        sandbox = self.sandboxes.get(sandbox_id)
        if not sandbox:
            return
        active_runs = self.daemon_store.list_active_runs(sandbox_id)
        if active_runs:
            raise ValueError(
                "Daemon node has active runs; cancel them before deleting."
            )
        active_run_requests = [
            request
            for request in self.daemon_store.list_active_run_requests()
            if request.get("nodeId") == sandbox_id
            or any(
                assignment.get("daemonNodeId") == sandbox_id
                for assignment in request.get("assignments") or []
            )
        ]
        if active_run_requests:
            raise ValueError(
                "Daemon node has active agent work. Wait for its runs to finish before deleting it."
            )
        self.daemon_store.delete_node(sandbox_id)
        self.sandboxes.pop(sandbox_id, None)
        self.plain_node_tokens.pop(sandbox_id, None)
        self._last_seen_persisted_at.pop(sandbox_id, None)
        for command_id, command in list(self.active_commands.items()):
            if (
                command.get("sandboxId") == sandbox_id
                or command.get("nodeId") == sandbox_id
            ):
                self.active_commands.pop(command_id, None)
                if command.get("runId"):
                    self.clear_run_output(command["runId"])
        logger.info("Daemon node deleted", sandbox_id=sandbox_id)

    def retire_deleted(self, sandbox_id: str) -> dict[str, Any]:
        """Delete a node from the Admin Console, leaving a tombstone behind.

        `delete` drops the row entirely, which lets a daemon that is still
        running on the machine re-register and resurrect the node. The
        tombstone keeps the deletion durable; `_deleted_tombstone` rejects the
        re-registration and the daemon shuts itself down.
        """
        sandbox = self._live_node(sandbox_id)
        if not sandbox:
            raise KeyError(sandbox_id)
        if self.daemon_store.list_active_runs(sandbox_id):
            raise ValueError(
                "Daemon node has active runs; cancel them before deleting."
            )
        active_run_requests = [
            request
            for request in self.daemon_store.list_active_run_requests()
            if request.get("nodeId") == sandbox_id
            or any(
                assignment.get("daemonNodeId") == sandbox_id
                for assignment in request.get("assignments") or []
            )
        ]
        if active_run_requests:
            raise ValueError(
                "Daemon node has active agent work. Wait for its runs to finish before deleting it."
            )
        deleted_at = now_iso()
        updated = {
            **sandbox,
            "retiredAt": deleted_at,
            "status": DAEMON_NODE_DELETED_STATUS,
            "updatedAt": deleted_at,
        }
        # A tombstone exists to reject re-registration, not to keep a working
        # credential around: the reveal-anytime secret dies with the node.
        updated.pop("nodeTokenSecret", None)
        self.sandboxes[sandbox_id] = updated
        self.daemon_store.register_node(updated)
        self.plain_node_tokens.pop(sandbox_id, None)
        self._last_seen_persisted_at.pop(sandbox_id, None)
        for command_id, command in list(self.active_commands.items()):
            if (
                command.get("sandboxId") == sandbox_id
                or command.get("nodeId") == sandbox_id
            ):
                self.active_commands.pop(command_id, None)
                if command.get("runId"):
                    self.clear_run_output(command["runId"])
        computer = computer_id(updated)
        target = self.live_cleanup_node(computer)
        if target is not None:
            self.rehome_workspace_cleanups(computer, target["id"])
        logger.info("Daemon node deleted", sandbox_id=sandbox_id)
        return updated

    def provision_pending(
        self,
        user_id: str | None = None,
        workspace_path: str | None = None,
        sandbox_mode: str = "boxlite",
        node_location: str | None = "user-device",
        display_name: str | None = None,
    ) -> tuple[dict[str, Any], str | None, str | None]:
        if sandbox_mode not in DAEMON_SANDBOX_MODES:
            sandbox_mode = "boxlite"
        enrollment_key = (
            local_enrollment_key(user_id, workspace_path)
            if node_location == "user-device"
            else None
        )
        if user_id:
            existing = self.find_by_user(user_id, workspace_path)
            if existing:
                node_token = self.plain_node_tokens.get(existing["id"])
                updates: dict[str, Any] = {}
                if not existing.get("sandboxMode"):
                    updates["sandboxMode"] = sandbox_mode
                # `find_by_user` treats a pathless node as matching any
                # workspace, so reuse can land on a record that never learned
                # where its work goes. Adopt the caller's path instead of
                # silently discarding it — an enrollment that reports back a
                # blank workspace is worse than a second node.
                if workspace_path and not existing.get("workspacePath"):
                    updates["workspacePath"] = workspace_path
                if not existing.get("nodeLocation") and node_location:
                    updates["nodeLocation"] = node_location
                if display_name and display_name != existing.get("displayName"):
                    updates["displayName"] = display_name
                if updates:
                    existing = {
                        **existing,
                        **updates,
                        "updatedAt": now_iso(),
                    }
                    self.sandboxes[existing["id"]] = existing
                    self.daemon_store.register_node(existing)
                if (
                    node_location == "user-device"
                    and existing.get("status") == "provisioning"
                    and not node_token
                ):
                    # Reissuing an unfinished enrollment rotates the old
                    # credential instead of creating a duplicate node.
                    node_token = new_daemon_node_token()
                    existing = {
                        **existing,
                        "nodeTokenHash": hash_daemon_node_token(node_token),
                        "updatedAt": now_iso(),
                    }
                    self.sandboxes[existing["id"]] = existing
                    self.daemon_store.register_node(existing)
                    self._remember_control_panel_node_token(existing, node_token)
                return (
                    existing,
                    None,
                    node_token,
                )
        sandbox_id = new_sandbox_id()
        ui_token = new_daemon_node_token()
        node_token = new_daemon_node_token()
        now = now_iso()
        sandbox: dict[str, Any] = {
            "id": sandbox_id,
            **({"userId": user_id} if user_id else {}),
            **({"workspacePath": workspace_path} if workspace_path else {}),
            **({"enrollmentKey": enrollment_key} if enrollment_key else {}),
            **({"displayName": display_name} if display_name else {}),
            "sandboxMode": sandbox_mode,
            **({"nodeLocation": node_location} if node_location else {}),
            "status": "provisioning",
            "agents": {agent: "unknown" for agent in AGENT_NAMES},
            "maxConcurrentRuns": 1,
            "uiTokenHash": hash_daemon_node_token(ui_token),
            "nodeTokenHash": hash_daemon_node_token(node_token),
            "createdAt": now,
            "updatedAt": now,
            "lastError": "Waiting for daemon node registration.",
        }
        created = True
        if enrollment_key:
            sandbox, created = self.daemon_store.claim_pending_node(sandbox)
            node_token = node_token if created else self.plain_node_tokens.get(sandbox["id"])
        else:
            self.daemon_store.register_node(sandbox)
        self.sandboxes[sandbox["id"]] = sandbox
        self._remember_control_panel_node_token(sandbox, node_token)
        logger.info(
            "Daemon node provisioned",
            sandbox_id=sandbox["id"],
            user_id=user_id,
            workspace_path=workspace_path,
            reused=not created,
        )
        return sandbox, ui_token if created else None, node_token

    def _remember_control_panel_node_token(
        self, sandbox: dict[str, Any], token: str | None
    ) -> None:
        """Cache only control-panel launch credentials, until process restart."""
        if token and not sandbox.get("managedNodeId"):
            self.plain_node_tokens[sandbox["id"]] = token

    def enroll_managed_node(
        self,
        managed_node: dict[str, Any],
        attempt: dict[str, Any],
        payload: dict[str, Any],
        enrollment_credential: str | None = None,
    ) -> tuple[dict[str, Any], str]:
        """Create or replay the observed daemon identity for an enrollment grant."""
        prior = next(
            (
                sandbox
                for sandbox in self.sandboxes.values()
                if sandbox.get("provisioningAttemptId") == attempt["id"]
            ),
            None,
        )
        if prior:
            if not enrollment_credential:
                raise ValueError("Provisioning attempt already has a daemon runtime.")
            replay_token = managed_daemon_node_token(
                enrollment_credential, prior["id"]
            )
            if not daemon_node_token_matches(prior, replay_token):
                raise PermissionError("Enrollment credential cannot recover this runtime.")
            return prior, replay_token
        active_runtime = next(
            (
                sandbox
                for sandbox in self.sandboxes.values()
                if sandbox.get("managedNodeId") == managed_node["id"]
                and not sandbox.get("retiredAt")
            ),
            None,
        )
        if active_runtime:
            raise ValueError("Managed node already has an active daemon runtime.")
        sandbox_id = new_sandbox_id()
        node_token = (
            managed_daemon_node_token(enrollment_credential, sandbox_id)
            if enrollment_credential
            else new_daemon_node_token()
        )
        now = now_iso()
        sandbox: dict[str, Any] = {
            "id": sandbox_id,
            **(
                {"userId": managed_node["userId"]}
                if managed_node.get("userId")
                else {}
            ),
            **(
                {"workspacePath": payload["workspacePath"]}
                if payload.get("workspacePath")
                else {}
            ),
            "sandboxMode": managed_node.get("sandboxMode") or "boxlite",
            "nodeLocation": "managed",
            "managedNodeId": managed_node["id"],
            "provisioningAttemptId": attempt["id"],
            "credentialVersion": 1,
            "status": "provisioning",
            "agents": {agent: "unknown" for agent in AGENT_NAMES},
            "maxConcurrentRuns": 1,
            "nodeTokenHash": hash_daemon_node_token(node_token),
            "createdAt": now,
            "updatedAt": now,
            "lastError": "Waiting for daemon node registration.",
        }
        self.sandboxes[sandbox_id] = sandbox
        # Managed runtime credentials are intentionally not added to
        # plain_node_tokens and therefore cannot be recovered by control-panel
        # reads after this response.
        self.daemon_store.register_node(sandbox)
        logger.info(
            "Managed daemon node enrolled",
            sandbox_id=sandbox_id,
            managed_node_id=managed_node["id"],
            attempt_id=attempt["id"],
        )
        return sandbox, node_token
