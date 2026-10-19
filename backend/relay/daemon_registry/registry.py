"""``DaemonNodeRegistry``: the backend's execution mechanism for daemon nodes.

The registry admits nodes, queues their commands, and walks each run request
through its collaboration round. It decides nothing about the round itself;
``collaboration/policy.py`` and ``work.py`` choose transitions and the
registry applies them. The class is assembled from one mixin per concern,
grouped into the ``nodes``, ``dispatch``, and ``runs`` subpackages (see
``state.py``); this module owns the shared state and the two lock levels
(``locks.py``).
"""

from __future__ import annotations

import threading
from collections.abc import Callable, Iterator
from contextlib import contextmanager
from dataclasses import dataclass
from threading import Lock, RLock
from typing import Any


from ..persistence.protocols import SessionStore, TaskStore
from . import config
from .nodes.registration import NodeRegistrationMixin
from .nodes.liveness import NodeLivenessMixin
from .nodes.admin import NodeAdministrationMixin
from .dispatch.commands import CommandQueueMixin
from .dispatch.admission import RunAdmissionMixin
from .dispatch.delivery import AssignmentDeliveryMixin
from .dispatch.follow_up import FollowUpRetryMixin
from .runs.progression import RunProgressionMixin
from .runs.transitions import RunTransitionMixin
from .runs.failure import RunFailureMixin
from .runs.completion import RunCompletionMixin
from .runs.events import EventIngestMixin
from .runs.reaper import RunReaperMixin
from .locks import GlobalDispatchLock


@dataclass
class _DispatchLockEntry:
    lock: Any
    users: int = 0


class DaemonNodeRegistry(
    NodeRegistrationMixin,
    NodeLivenessMixin,
    NodeAdministrationMixin,
    CommandQueueMixin,
    RunAdmissionMixin,
    AssignmentDeliveryMixin,
    FollowUpRetryMixin,
    RunProgressionMixin,
    RunTransitionMixin,
    RunFailureMixin,
    RunCompletionMixin,
    EventIngestMixin,
    RunReaperMixin,
):
    def __init__(
        self,
        store: SessionStore,
        daemon_store: Any,
        *,
        task_store: TaskStore | None = None,
        project_store: Any = None,
        liveness_timeout_ms: int = config.DAEMON_NODE_LIVENESS_TIMEOUT_MS,
    ):
        self.store = store
        self.daemon_store = daemon_store
        self.daemon_store.session_store = store
        self.task_store = task_store
        self.project_store = project_store
        self.liveness_timeout_ms = liveness_timeout_ms
        self.sandboxes: dict[str, dict[str, Any]] = {}
        self.active_commands: dict[str, dict[str, Any]] = {}
        self.outputs: dict[str, list[str]] = {}
        self.output_sizes: dict[str, int] = {}
        self.output_sequences: dict[str, dict[str, int]] = {}
        self.output_sequences_hydrated: set[str] = set()
        # Control-panel provisioning needs to render the launch command again
        # during the current backend process. This cache is deliberately
        # ephemeral and is never used for managed enrollment credentials,
        # which are delivered exactly once by the enrollment response.
        self.plain_node_tokens: dict[str, str] = {}
        # Node locks this thread holds; the global lock refuses to be taken
        # under one (locks.py).
        self._node_lock_depth = threading.local()
        self.dispatch_lock = GlobalDispatchLock(
            lambda: getattr(self._node_lock_depth, "value", 0)
        )
        # (run request id, assignment index) pairs whose slot wait was logged.
        self._logged_capacity_waits: set[tuple[str, int]] = set()
        self._dispatch_locks_guard = RLock()
        self._dispatch_locks: dict[str, _DispatchLockEntry] = {}
        self.logical_assignment_validator: Callable[[dict[str, Any]], None] | None = (
            None
        )
        self.logical_skill_bundle_resolver: (
            Callable[
                [str, str | None],
                tuple[dict[str, Any] | None, list[dict[str, Any]]],
            ]
            | None
        ) = None
        self._recovery_lock = Lock()
        self._last_reap_at = 0.0
        self._last_prune_at = 0.0
        self._last_seen_persisted_at: dict[str, float] = {}
        self._last_fleet_liveness_refresh_at = 0.0
        self._last_progress_persisted_at: dict[str, float] = {}
        self._load_persisted_state()

    @contextmanager
    def dispatch_scope(self, node_ids: list[str]) -> Iterator[None]:
        """Serialize one node's mutations without blocking unrelated nodes."""
        keys = sorted({node_id for node_id in node_ids if node_id})
        with self._dispatch_locks_guard:
            entries = []
            for key in keys:
                entry = self._dispatch_locks.setdefault(
                    key, _DispatchLockEntry(RLock())
                )
                entry.users += 1
                entries.append((key, entry))
        for _, entry in entries:
            entry.lock.acquire()
        depth = getattr(self._node_lock_depth, "value", 0)
        self._node_lock_depth.value = depth + len(entries)
        try:
            yield
        finally:
            self._node_lock_depth.value = depth
            for _, entry in reversed(entries):
                entry.lock.release()
            with self._dispatch_locks_guard:
                for key, entry in entries:
                    entry.users -= 1
                    if entry.users == 0 and self._dispatch_locks.get(key) is entry:
                        self._dispatch_locks.pop(key, None)
