"""Turn computer liveness and client-version changes into notifications.

A computer's online state is derived from its last heartbeat at read time, so
there is no write to hook: this loop observes every computer on an interval
and records what it saw in ``notification_watch_state``. A notice is written
only when that record moves, through a compare-and-set, so every replica may
run the loop and each transition is still announced once.

The first sighting of a computer only records its liveness — a backend
restart is not news. Going offline is announced only once this process has
seen the computer offline for ``offline_confirm_seconds``: a network blip or a
backend outage (every heartbeat looks stale until daemons reconnect, within
10 s) is not news either. An outdated client is announced on first sighting,
since a deploy that makes existing computers outdated is exactly the news.

The outdated state records which capabilities were missing and only grows or
clears when the computer itself advertises them, so during a rolling deploy a
replica that knows fewer capabilities cannot flip it back and forth.
"""

from __future__ import annotations

import asyncio
import os
import time
from datetime import datetime, timedelta, timezone
from typing import Any

from loguru import logger

from ..daemon_registry.client_version import missing_capabilities
from ..daemon_registry.registry import DAEMON_NODE_CAPABILITIES
from .rules import client_outdated_rows, computer_status_rows

ONLINE_PREFIX = "computer-online:"
OUTDATED_PREFIX = "client-outdated:"
OUTDATED_STATE = "outdated:"
CURRENT_STATE = "current"
RETENTION = timedelta(days=90)
PRUNE_EVERY_SECONDS = 3600.0
# Longer than a daemon's 10 s reconnect ceiling, with room for a slow restart.
OFFLINE_CONFIRM_SECONDS = 60.0
STOP_TIMEOUT_SECONDS = 30.0


def recipient_id(account: dict[str, Any]) -> str:
    """The id an Account's notices are filed under: its User, else itself
    (a bootstrap admin may have no User)."""
    return str(account.get("userId") or account["id"])


def node_online_state(node: dict[str, Any]) -> str:
    return "online" if node.get("online") and node.get("status") != "stopped" else "offline"


def outdated_state(missing: set[str]) -> str:
    return OUTDATED_STATE + ",".join(sorted(missing)) if missing else CURRENT_STATE


def recorded_missing(state: str | None) -> set[str] | None:
    """The capabilities a recorded outdated state names; None unless outdated."""
    if not state or not state.startswith(OUTDATED_STATE):
        return None
    return {item for item in state[len(OUTDATED_STATE):].split(",") if item}


class ComputerNotificationWatcher:
    def __init__(
        self, registry: Any, auth_store: Any, store: Any, *, interval_seconds: float = 15.0,
        offline_confirm_seconds: float = OFFLINE_CONFIRM_SECONDS,
        known_capabilities: frozenset[str] = DAEMON_NODE_CAPABILITIES,
        clock: Any = time.monotonic,
    ) -> None:
        self.registry = registry
        self.auth_store = auth_store
        self.store = store
        self.interval_seconds = interval_seconds
        self.offline_confirm_seconds = offline_confirm_seconds
        self.known_capabilities = known_capabilities
        self.clock = clock
        self._stop = asyncio.Event()
        self._task: asyncio.Task | None = None
        self._last_prune = 0.0
        # When this process first saw each computer offline, still unannounced.
        self._offline_since: dict[str, float] = {}

    def recipients(self, node: dict[str, Any]) -> list[str]:
        """The computer's user, or every admin for shared hardware no user holds."""
        if node.get("userId"):
            return [str(node["userId"])]
        return sorted({
            recipient_id(account) for account in self.auth_store.list_accounts()
            if account.get("role") == "admin"
        })

    def tick(self) -> None:
        # Placeholders that never registered have no liveness or client to report.
        nodes = [node for node in self.registry.monitor_nodes() if node.get("lastSeenAt")]
        online_states = self.store.watch_states(ONLINE_PREFIX)
        outdated_states = self.store.watch_states(OUTDATED_PREFIX)
        for node in nodes:
            try:
                self._observe_online(node, online_states.get(ONLINE_PREFIX + node["id"]))
                self._observe_client(node, outdated_states.get(OUTDATED_PREFIX + node["id"]))
            except Exception:
                logger.exception("Computer notification check failed", node_id=node.get("id"))
        present = {node["id"] for node in nodes}
        self._offline_since = {
            node_id: since for node_id, since in self._offline_since.items() if node_id in present
        }
        live = {prefix + node_id for node_id in present for prefix in (ONLINE_PREFIX, OUTDATED_PREFIX)}
        self.store.forget_watch_states(sorted((set(online_states) | set(outdated_states)) - live))
        self._prune()

    def _observe_online(self, node: dict[str, Any], previous: str | None) -> None:
        current = node_online_state(node)
        if current == "online":
            self._offline_since.pop(node["id"], None)
        if previous == current:
            return
        if current == "offline" and previous is not None:
            since = self._offline_since.setdefault(node["id"], self.clock())
            if self.clock() - since < self.offline_confirm_seconds:
                return
        rows = computer_status_rows(node, self.recipients(node), previous, current) if previous else []
        if self.store.claim_transition(ONLINE_PREFIX + node["id"], previous, current, rows) and rows:
            logger.info("Computer status notification", node_id=node["id"], status=current)

    def _observe_client(self, node: dict[str, Any], previous: str | None) -> None:
        missing = set(missing_capabilities(node, self.known_capabilities))
        recorded = recorded_missing(previous)
        if missing:
            if recorded is not None and missing <= recorded:
                return  # Already announced; a lagging replica may see less.
            state = outdated_state(missing | (recorded or set()))
            rows = client_outdated_rows(node, self.recipients(node), sorted(recorded_missing(state) or ()))
        else:
            if previous == CURRENT_STATE:
                return
            if recorded and not recorded <= set(node.get("capabilities") or []):
                return  # This replica does not know what the computer lacks.
            state, rows = CURRENT_STATE, []
        if self.store.claim_transition(OUTDATED_PREFIX + node["id"], previous, state, rows) and rows:
            logger.info("Outdated client notification", node_id=node["id"], state=state)

    def _prune(self) -> None:
        now = time.monotonic()
        if self._last_prune and now - self._last_prune < PRUNE_EVERY_SECONDS:
            return
        self._last_prune = now
        removed = self.store.prune(datetime.now(timezone.utc) - RETENTION)
        if removed:
            logger.info("Pruned old notifications", count=removed)

    def start(self) -> None:
        if self._task and not self._task.done():
            return
        self._stop.clear()
        self._task = asyncio.create_task(self._run(), name="relay-computer-notifications")

    async def _run(self) -> None:
        while not self._stop.is_set():
            try:
                await asyncio.to_thread(self.tick)
            except Exception:
                logger.exception("Computer notification tick failed; retrying")
            try:
                await asyncio.wait_for(self._stop.wait(), self.interval_seconds)
            except TimeoutError:
                pass

    async def stop(self) -> None:
        self._stop.set()
        if self._task:
            try:
                # Let a tick finish its writes, but never hold shutdown hostage.
                await asyncio.wait_for(asyncio.shield(self._task), STOP_TIMEOUT_SECONDS)
            except TimeoutError:
                logger.warning("Computer notification tick still running at shutdown")
            self._task = None


def watch_interval_from_env() -> float:
    return max(1.0, float(os.environ.get("RELAY_NOTIFICATION_WATCH_INTERVAL_SECONDS", "15")))
