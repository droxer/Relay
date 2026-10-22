"""Node liveness and the live node view: lookups, monitoring, selection, authorization, and persisted liveness.

A mixin of ``DaemonNodeRegistry``: it shares the registry's state and locks
(declared on ``RegistryState``) and is not used on its own.
"""

from __future__ import annotations

import time
from collections import defaultdict
from datetime import datetime
from typing import Any
from loguru import logger
from ...core.timestamps import iso_epoch_ms
from ...core.ids import now_iso
from ...core.models import (
    AGENT_NAMES,
)
from ...persistence.daemon.rules import infer_node_location, NODE_POLL_DRAINED_AT
from ...core.daemon_capabilities import (
    client_outdated,
)
from ..credentials import (
    daemon_node_token_matches,
    sandbox_ui_token_matches,
)
from ..scheduling import (
    node_accepts_run,
    node_status_for_active_runs,
    workspace_paths_match,
)
from .. import config
from ..records import (
    DAEMON_NODE_DELETED_STATUS,
    DeletedDaemonNodeError,
    UnknownDaemonNodeError,
    daemon_active_run,
    public_sandbox_record,
)
from ..state import RegistryState


def _newest(key: str, *records: dict[str, Any]) -> dict[str, Any]:
    """The later of two ISO timestamps by epoch, not by string shape."""
    candidates = [(iso_epoch_ms(record.get(key)), record.get(key)) for record in records]
    dated = [(ms, value) for ms, value in candidates if ms is not None and value]
    if not dated:
        return {}
    return {key: max(dated)[1]}


class NodeLivenessMixin(RegistryState):
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
                    "dispatchable": liveness["dispatchable"],
                    "clientOutdated": client_outdated(sandbox),
                    **(
                        {"lastSeenAgeMs": liveness["lastSeenAgeMs"]}
                        if "lastSeenAgeMs" in liveness
                        else {}
                    ),
                    **(
                        {"lastPollAgeMs": liveness["lastPollAgeMs"]}
                        if "lastPollAgeMs" in liveness
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
            if liveness["dispatchable"] and node_accepts_run(sandbox, active_runs=active_runs)
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

    @staticmethod
    def _persist_due(stamps: dict[str, float], sandbox_id: str) -> bool:
        monotonic_now = time.monotonic()
        last = stamps.get(sandbox_id)
        if (
            last is not None
            and monotonic_now - last < config.DAEMON_NODE_SEEN_PERSIST_INTERVAL_SECONDS
        ):
            return False
        stamps[sandbox_id] = monotonic_now
        return True

    def _should_persist_seen(self, sandbox_id: str, *, polled: bool = False) -> bool:
        """Rate-limit durable heartbeat writes under the node dispatch scope.

        A poll observation keeps its own clock. The long poll renews leases
        (a plain observation) right before it takes commands (the poll
        observation), so on one shared clock the plain write always won and
        ``lastPollAt`` never reached the row — and another replica, which
        reads only the row, saw a listening node as not dispatchable.
        """
        due = self._persist_due(self._last_seen_persisted_at, sandbox_id)
        if polled and self._persist_due(self._last_poll_persisted_at, sandbox_id):
            due = True
        return due

    def _mark_seen(self, sandbox_id: str, *, polled: bool | None = None) -> None:
        """Record an observation of the daemon.

        ``polled`` True is a command poll (the node is listening for work);
        False is a draining daemon saying it will not poll again; None is any
        other authenticated traffic, which proves liveness only.
        """
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
                **(
                    {"lastPollAt": now}
                    if polled
                    else {"lastPollAt": NODE_POLL_DRAINED_AT}
                    if polled is False
                    else {}
                ),
            }
            if "lastError" in patch and patch["lastError"] is None:
                updated.pop("lastError", None)
            self.sandboxes[sandbox_id] = updated
            # An idle long poll calls this several times per second per node.
            # The in-memory view above stays exact for this replica's liveness
            # checks; the durable write is throttled well inside the liveness
            # timeout so other replicas still see the node as online. A drain
            # is written at once: dispatch on every replica must stop now.
            if (
                revived
                or polled is False
                or self._should_persist_seen(sandbox_id, polled=bool(polled))
            ):
                self.daemon_store.mark_node_seen(sandbox_id, patch, polled=polled)
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
        """Merge newer durable lease observations from another backend replica.

        The fleet-wide form (no id) is throttled to one store read per persist
        interval: another replica cannot have written anything newer than that
        in between, and every list route calls this, so an unthrottled read
        would scan ``daemon_nodes`` under the global lock on each request.
        """
        with self.dispatch_lock:
            if sandbox_id is None:
                monotonic_now = time.monotonic()
                if (
                    monotonic_now - self._last_fleet_liveness_refresh_at
                    < config.DAEMON_NODE_SEEN_PERSIST_INTERVAL_SECONDS
                ):
                    return
                self._last_fleet_liveness_refresh_at = monotonic_now
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
                refreshed = {
                    **current,
                    **persisted,
                    **_newest("lastSeenAt", persisted, current),
                    **_newest("updatedAt", persisted, current),
                    **_newest("lastPollAt", persisted, current),
                }
                if persisted.get("retiredAt"):
                    refreshed["agents"] = current.get("agents", refreshed.get("agents"))
                current_is_newer = (iso_epoch_ms(current.get("lastSeenAt")) or 0) >= (
                    iso_epoch_ms(persisted.get("lastSeenAt")) or 0
                )
                if current_is_newer and not persisted.get("retiredAt"):
                    refreshed["status"] = current.get("status", persisted.get("status"))
                    if current.get("lastError"):
                        refreshed["lastError"] = current["lastError"]
                    else:
                        refreshed.pop("lastError", None)
                self.sandboxes[persisted["id"]] = refreshed

    def _liveness(self, sandbox: dict[str, Any]) -> dict[str, Any]:
        if sandbox.get("status") == "stopped" or not sandbox.get("lastSeenAt"):
            return {"online": False, "stale": True, "dispatchable": False}
        seen_ms = iso_epoch_ms(sandbox["lastSeenAt"])
        if seen_ms is None:
            logger.warning(
                "Failed to parse lastSeenAt for sandbox liveness",
                sandbox_id=sandbox.get("id"),
                last_seen=sandbox.get("lastSeenAt"),
            )
            return {"online": False, "stale": True, "dispatchable": False}
        now_ms = time.time() * 1000
        age = max(0, int(now_ms - seen_ms))
        online = age <= self.liveness_timeout_ms
        if not online:
            logger.debug(
                "Daemon node stale", sandbox_id=sandbox["id"], last_seen_age_ms=age
            )
        # Alive is not the same as listening for work. A daemon that beats but
        # whose command poll is failing (or that said it is draining) must not
        # be handed a run it will never take. A node that has not polled yet
        # keeps the benefit of the doubt: its first poll follows registration
        # within a second.
        poll_ms = iso_epoch_ms(sandbox.get("lastPollAt"))
        poll_age = max(0, int(now_ms - poll_ms)) if poll_ms is not None else None
        dispatchable = online and (
            poll_age is None or poll_age <= self.poll_freshness_ms
        )
        return {
            "online": online,
            "stale": not online,
            "dispatchable": dispatchable,
            "lastSeenAgeMs": age,
            **({"lastPollAgeMs": poll_age} if poll_age is not None else {}),
        }

    def is_dispatchable(self, sandbox_id: str) -> bool:
        """Live and listening for commands: the admission rule for new work."""
        self._refresh_persisted_liveness(sandbox_id)
        sandbox = self.sandboxes.get(sandbox_id)
        return bool(sandbox and self._liveness(sandbox)["dispatchable"])

    @property
    def poll_freshness_ms(self) -> int:
        """How old a node's last command poll may be and still count as listening.

        One maximal long-poll hold plus the liveness window: a poll held the
        full wait and then delayed by whatever the heartbeat tolerates.
        """
        return int(config.COMMAND_POLL_MAX_WAIT_SECONDS * 1000) + self.liveness_timeout_ms
