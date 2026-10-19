"""The daemon registry's tunables: timeouts, leases, retention, and bounds.

Every environment-backed value comes from one validated read
(``core/settings.py``). Registry code reads them as ``config.NAME`` at call
time, never ``from .config import NAME``, so a test can override one with
``monkeypatch.setattr(config, "NAME", ...)`` and every registry module sees it.
"""

from __future__ import annotations

from ..collaboration.policy import DEFAULT_RUNTIME_FAILURE_REPAIRS
from ..core.settings import RegistrySettings

REGISTRY_SETTINGS = RegistrySettings.from_env(default_max_repairs=DEFAULT_RUNTIME_FAILURE_REPAIRS)

DAEMON_NODE_LIVENESS_TIMEOUT_MS = REGISTRY_SETTINGS.node_liveness_timeout_ms
DAEMON_RUN_TIMEOUT_MS = REGISTRY_SETTINGS.run_timeout_ms
DAEMON_RUN_MAX_DURATION_MS = REGISTRY_SETTINGS.run_max_duration_ms
DAEMON_RUN_PROGRESS_PERSIST_INTERVAL_SECONDS = REGISTRY_SETTINGS.run_progress_persist_interval_seconds
DAEMON_NODE_SEEN_PERSIST_INTERVAL_SECONDS = REGISTRY_SETTINGS.node_seen_persist_interval_seconds
DAEMON_COMMAND_LEASE_SECONDS = REGISTRY_SETTINGS.command_lease_seconds
# The longest a command long-poll may be held. A node whose last poll is older
# than this plus the liveness timeout is alive but not listening for work.
COMMAND_POLL_MAX_WAIT_SECONDS = 30.0
# Heartbeats per liveness window: a daemon may miss four beats before expiry.
HEARTBEATS_PER_LIVENESS_WINDOW = 5
# How long past expiry a delivered run.start's lease must sit unrenewed on a
# live node before the reaper treats the start as lost. One full lease period
# leaves room for heartbeats delayed by a slow poll or a backend restart.
LOST_DISPATCH_GRACE_SECONDS = DAEMON_COMMAND_LEASE_SECONDS
DAEMON_COMMAND_RETENTION_SECONDS = REGISTRY_SETTINGS.command_retention_seconds
SESSION_OUTPUT_RETENTION_DAYS = REGISTRY_SETTINGS.session_output_retention_days
DAEMON_RUN_REQUEST_RETENTION_SECONDS = REGISTRY_SETTINGS.run_request_retention_seconds
DAEMON_TERMINAL_RECORD_LIMIT = REGISTRY_SETTINGS.terminal_record_limit
DAEMON_RECORD_PRUNE_INTERVAL_SECONDS = REGISTRY_SETTINGS.record_prune_interval_seconds
DAEMON_RUN_MAX_REPAIRS = REGISTRY_SETTINGS.run_max_repairs
TERMINAL_CLAIM_LEASE_SECONDS = REGISTRY_SETTINGS.terminal_claim_lease_seconds
DISPATCH_CLAIM_LEASE_SECONDS = REGISTRY_SETTINGS.dispatch_claim_lease_seconds
PREPARED_ADMISSION_LEASE_SECONDS = REGISTRY_SETTINGS.prepared_admission_lease_seconds
RUN_OUTPUT_BUFFER_MAX_CHARS = REGISTRY_SETTINGS.run_output_buffer_max_chars

# Bound one registration's journal report; the daemon sends the rest next time.
JOURNAL_REPORT_LIMIT = 200
# Failures starting the next assignment (or closing the round) after a turn was
# finalized; past the cap the thread fails.
MAX_FOLLOW_UP_ATTEMPTS = 5
# Bound on remembered slot waits; past it the log may repeat, never grow.
LOGGED_CAPACITY_WAITS_MAX = 10_000
