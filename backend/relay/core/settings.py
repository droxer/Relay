"""Typed backend settings, read from the environment once and validated together.

Each group is a frozen dataclass built by ``from_env``. A bad value never
surfaces later as a bare ``ValueError`` mid-request: every problem in a group is
collected and raised as one ``SettingsError`` naming each variable, so a
misconfigured deploy fails at startup with the whole list.

- ``AppSettings`` is read by ``create_app`` and published as
  ``app.state.settings`` for request handlers.
- ``RegistrySettings`` and ``StreamSettings`` are read when their module is
  imported; those modules keep module-level names for the values so tests can
  still override one with ``monkeypatch.setattr``.

Feature-specific configuration that already validates itself at startup
(mail, blob storage, the waitlist, password resets, the database pool) keeps
its own ``*_from_env`` beside the feature.
"""

from __future__ import annotations

import os
from collections.abc import Mapping
from dataclasses import dataclass
from datetime import date, datetime
from pathlib import Path
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from .environment import load_backend_env
from .managed_node_policy import DEFAULT_MANAGED_NODE_PROVIDER

_TRUE = frozenset({"1", "true", "yes", "on"})
_FALSE = frozenset({"0", "false", "no", "off"})


class SettingsError(ValueError):
    """One or more environment variables hold an invalid value."""

    def __init__(self, problems: list[str]) -> None:
        self.problems = problems
        super().__init__("Invalid backend configuration:\n- " + "\n- ".join(problems))


class EnvReader:
    """Reads typed values and collects every problem instead of stopping at one."""

    def __init__(self, environ: Mapping[str, str] | None = None) -> None:
        self._environ = os.environ if environ is None else environ
        self.problems: list[str] = []

    def _raw(self, name: str) -> str | None:
        value = self._environ.get(name)
        return None if value is None or not value.strip() else value.strip()

    def text(self, name: str, default: str = "") -> str:
        return self._raw(name) or default

    def choice(self, name: str, default: str, choices: tuple[str, ...]) -> str:
        raw = self._raw(name)
        if raw is None:
            return default
        lowered = raw.lower()
        if lowered in choices:
            return lowered
        self.problems.append(f"{name} must be one of {', '.join(choices)}, got {raw!r}.")
        return default

    def flag(self, name: str, default: bool) -> bool:
        raw = self._raw(name)
        if raw is None:
            return default
        lowered = raw.lower()
        if lowered in _TRUE:
            return True
        if lowered in _FALSE:
            return False
        self.problems.append(f"{name} must be a boolean (1/0, true/false, yes/no, on/off), got {raw!r}.")
        return default

    def integer(self, name: str, default: int, *, minimum: int | None = None, maximum: int | None = None) -> int:
        raw = self._raw(name)
        if raw is None:
            return default
        try:
            value = int(raw)
        except ValueError:
            self.problems.append(f"{name} must be an integer, got {raw!r}.")
            return default
        return self._bounded(name, value, minimum, maximum)

    def number(
        self, name: str, default: float, *, minimum: float | None = None, maximum: float | None = None
    ) -> float:
        raw = self._raw(name)
        if raw is None:
            return default
        try:
            value = float(raw)
        except ValueError:
            self.problems.append(f"{name} must be a number, got {raw!r}.")
            return default
        return self._bounded(name, value, minimum, maximum)

    def timezone(self, name: str) -> ZoneInfo | None:
        raw = self._raw(name)
        if raw is None:
            return None
        try:
            return ZoneInfo(raw)
        except (ZoneInfoNotFoundError, ValueError):
            self.problems.append(f"{name} must be an IANA timezone name, got {raw!r}.")
            return None

    def _bounded[T: (int, float)](self, name: str, value: T, minimum: T | None, maximum: T | None) -> T:
        if minimum is not None and value < minimum:
            self.problems.append(f"{name} must be at least {minimum}, got {value}.")
        elif maximum is not None and value > maximum:
            self.problems.append(f"{name} must be at most {maximum}, got {value}.")
        return value

    def check(self, condition: bool, problem: str) -> None:
        if not condition:
            self.problems.append(problem)

    def raise_if_invalid(self) -> None:
        if self.problems:
            raise SettingsError(self.problems)


@dataclass(frozen=True)
class RateLimit:
    attempts: int
    window_seconds: int


@dataclass(frozen=True)
class AppSettings:
    """What ``create_app`` and the request handlers configure from the environment."""

    channels_enabled: bool
    waitlist_enabled: bool
    # The token the chat gateway presents; empty disables chat-service actors.
    chat_token: str
    control_panel_version: str
    max_json_body_bytes: int
    web_ui_dist_dir: Path | None
    computer_bundle: Path | None
    task_scheduler_enabled: bool
    task_scheduler_interval_seconds: float
    task_scheduler_max_dispatches: int
    # Routine due dates are calendar days; without a zone they roll over at
    # server-local midnight, which surprises users in other zones.
    task_scheduler_timezone: ZoneInfo | None
    automation_outbox_batch: int
    # Idempotent record repairs at boot (migrations_runtime/startup.py).
    startup_repairs_enabled: bool
    # "embedded" runs the scheduler, recovery, and notification loops in the
    # API process; "external" leaves them to `relay worker` (background.py).
    background_mode: str
    # Which provider realizes a managed computer whose request names none
    # (core/managed_node_policy.py); "fly-machines" for cloud computers.
    managed_node_provider: str
    automation_webhook_limit: RateLimit
    automation_webhook_failure_limit: RateLimit
    waitlist_limit: RateLimit
    password_reset_limit: RateLimit

    @classmethod
    def from_env(cls, environ: Mapping[str, str] | None = None) -> AppSettings:
        if environ is None:
            load_backend_env()
        env = EnvReader(environ)
        web_ui_dir = env.text("RELAY_WEB_UI_DIST_DIR")
        bundle = env.text("RELAY_COMPUTER_BUNDLE")
        settings = cls(
            channels_enabled=env.flag("RELAY_CHANNELS_ENABLED", False),
            waitlist_enabled=env.flag("RELAY_WAITLIST_ENABLED", False),
            chat_token=env.text("RELAY_CHAT_TOKEN"),
            control_panel_version=env.text("RELAY_CONTROL_PANEL_VERSION", "python"),
            max_json_body_bytes=env.integer("RELAY_MAX_JSON_BODY_BYTES", 4 * 1024 * 1024, minimum=1),
            web_ui_dist_dir=Path(web_ui_dir) if web_ui_dir else None,
            computer_bundle=Path(bundle) if bundle else None,
            task_scheduler_enabled=env.flag("RELAY_TASK_SCHEDULER_ENABLED", True),
            task_scheduler_interval_seconds=env.number(
                "RELAY_TASK_SCHEDULER_INTERVAL_SECONDS", 10.0, minimum=0.01
            ),
            task_scheduler_max_dispatches=env.integer("RELAY_TASK_SCHEDULER_MAX_DISPATCHES", 5, minimum=1),
            task_scheduler_timezone=env.timezone("RELAY_TASK_SCHEDULER_TIMEZONE"),
            automation_outbox_batch=env.integer("RELAY_AUTOMATION_OUTBOX_BATCH", 200, minimum=1),
            startup_repairs_enabled=env.flag("RELAY_STARTUP_REPAIRS", True),
            background_mode=env.choice("RELAY_BACKGROUND_MODE", "embedded", ("embedded", "external")),
            managed_node_provider=env.text("RELAY_MANAGED_NODE_PROVIDER", DEFAULT_MANAGED_NODE_PROVIDER),
            automation_webhook_limit=RateLimit(
                env.integer("RELAY_AUTOMATION_WEBHOOK_RATE_LIMIT", 60, minimum=1), 60
            ),
            automation_webhook_failure_limit=RateLimit(
                env.integer("RELAY_AUTOMATION_WEBHOOK_FAILURE_LIMIT", 20, minimum=1), 60
            ),
            waitlist_limit=RateLimit(
                env.integer("RELAY_WAITLIST_RATE_LIMIT_ATTEMPTS", 5, minimum=1),
                env.integer("RELAY_WAITLIST_RATE_LIMIT_WINDOW_SECONDS", 600, minimum=1),
            ),
            password_reset_limit=RateLimit(
                env.integer("RELAY_PASSWORD_RESET_RATE_LIMIT_ATTEMPTS", 5, minimum=1),
                env.integer("RELAY_PASSWORD_RESET_RATE_LIMIT_WINDOW_SECONDS", 900, minimum=1),
            ),
        )
        env.raise_if_invalid()
        return settings

    def scheduler_today(self) -> date:
        if self.task_scheduler_timezone is None:
            return date.today()
        return datetime.now(self.task_scheduler_timezone).date()


@dataclass(frozen=True)
class RegistrySettings:
    """Timeouts, leases, and retention for the daemon registry."""

    node_liveness_timeout_ms: int
    # How long a run may go without reporting progress before it is treated as
    # hung, measured from the last progress report rather than from dispatch.
    run_timeout_ms: int
    # The backstop for a run that streams forever without finishing; measured
    # from dispatch, so it is the one bound progress reports cannot extend.
    run_max_duration_ms: int
    # Progress arrives per output chunk; persisting every one would write the
    # run request thousands of times per run for no extra safety.
    run_progress_persist_interval_seconds: float
    # How often an idle daemon's heartbeat reaches the durable node row. Kept
    # under the liveness timeout so a replica reading persisted state never
    # mistakes a live node for a stale one.
    node_seen_persist_interval_seconds: float
    command_lease_seconds: float
    command_retention_seconds: float
    # Opt-in: after this many days a completed run's streamed output is
    # redacted down to its agent.completed log. 0 keeps every chunk.
    session_output_retention_days: float
    # Terminal run requests are the idempotency record a retried dispatch
    # finds, so they outlive commands by a wide margin.
    run_request_retention_seconds: float
    terminal_record_limit: int
    record_prune_interval_seconds: float
    # Coordinator runtime-failure repairs per round (see collaboration/policy.py).
    run_max_repairs: int
    terminal_claim_lease_seconds: float
    dispatch_claim_lease_seconds: float
    prepared_admission_lease_seconds: float
    run_output_buffer_max_chars: int

    @classmethod
    def from_env(cls, environ: Mapping[str, str] | None = None, *, default_max_repairs: int = 1) -> RegistrySettings:
        if environ is None:
            load_backend_env()
        env = EnvReader(environ)
        settings = cls(
            # 30 s: a daemon beats every fifth of this, so one hung request
            # (bounded to one interval) plus two retries still fits inside it.
            node_liveness_timeout_ms=env.integer("RELAY_DAEMON_NODE_LIVENESS_TIMEOUT_MS", 30_000, minimum=1),
            run_timeout_ms=env.integer("RELAY_DAEMON_RUN_TIMEOUT_MS", 15 * 60 * 1000, minimum=1),
            run_max_duration_ms=env.integer("RELAY_DAEMON_RUN_MAX_DURATION_MS", 24 * 60 * 60 * 1000, minimum=1),
            run_progress_persist_interval_seconds=env.number(
                "RELAY_DAEMON_RUN_PROGRESS_PERSIST_INTERVAL_SECONDS", 30.0, minimum=0
            ),
            node_seen_persist_interval_seconds=env.number(
                "RELAY_DAEMON_NODE_SEEN_PERSIST_INTERVAL_SECONDS", 5.0, minimum=0
            ),
            command_lease_seconds=env.number("RELAY_DAEMON_COMMAND_LEASE_SECONDS", 60.0, minimum=0.001),
            command_retention_seconds=env.number(
                "RELAY_DAEMON_COMMAND_RETENTION_SECONDS", 6 * 60 * 60.0, minimum=0
            ),
            session_output_retention_days=env.number("RELAY_SESSION_OUTPUT_RETENTION_DAYS", 0.0, minimum=0),
            run_request_retention_seconds=env.number(
                "RELAY_DAEMON_RUN_REQUEST_RETENTION_SECONDS", 7 * 24 * 60 * 60.0, minimum=0
            ),
            terminal_record_limit=env.integer("RELAY_DAEMON_TERMINAL_RECORD_LIMIT", 500, minimum=0),
            record_prune_interval_seconds=env.number(
                "RELAY_DAEMON_RECORD_PRUNE_INTERVAL_SECONDS", 60.0, minimum=0
            ),
            run_max_repairs=env.integer("RELAY_DAEMON_RUN_MAX_REPAIRS", default_max_repairs, minimum=0),
            terminal_claim_lease_seconds=env.number(
                "RELAY_TERMINAL_CLAIM_LEASE_SECONDS", 15 * 60.0, minimum=0.001
            ),
            dispatch_claim_lease_seconds=env.number("RELAY_DISPATCH_CLAIM_LEASE_SECONDS", 60.0, minimum=0.001),
            prepared_admission_lease_seconds=env.number(
                "RELAY_PREPARED_ADMISSION_LEASE_SECONDS", 60.0, minimum=0.001
            ),
            run_output_buffer_max_chars=env.integer(
                "RELAY_RUN_OUTPUT_BUFFER_MAX_CHARS", 2 * 1024 * 1024, minimum=1
            ),
        )
        env.check(
            settings.node_seen_persist_interval_seconds * 1000 < settings.node_liveness_timeout_ms,
            "RELAY_DAEMON_NODE_SEEN_PERSIST_INTERVAL_SECONDS must stay under "
            "RELAY_DAEMON_NODE_LIVENESS_TIMEOUT_MS, or a replica reads live nodes as stale.",
        )
        env.raise_if_invalid()
        return settings


@dataclass(frozen=True)
class StreamSettings:
    """The thread event stream (SSE) a browser holds open."""

    # Tail-poll interval when no change notification arrives: the latency
    # floor for a missed publish. One version read per subscriber per tick.
    fallback_seconds: float
    event_page_limit: int
    # Upper bound on one connection. The client reconnects with Last-Event-ID,
    # so a cap below a proxy's own limit turns an opaque cut into a clean,
    # resumable `done` frame.
    max_seconds: float

    @classmethod
    def from_env(cls, environ: Mapping[str, str] | None = None) -> StreamSettings:
        if environ is None:
            load_backend_env()
        env = EnvReader(environ)
        settings = cls(
            fallback_seconds=env.number("RELAY_STREAM_FALLBACK_SECONDS", 1.0, minimum=1.0),
            event_page_limit=env.integer("RELAY_STREAM_EVENT_PAGE_LIMIT", 256, minimum=1, maximum=1000),
            max_seconds=env.number("RELAY_STREAM_MAX_SECONDS", 30 * 60.0, minimum=5.0),
        )
        env.raise_if_invalid()
        return settings
