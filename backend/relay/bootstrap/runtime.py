"""Background services the app runs beside its routes: the task scheduler and rate limiters.
"""

from __future__ import annotations

from collections.abc import Callable
from datetime import date
from ..daemon_registry.registry import DaemonNodeRegistry
from ..daemon_registry.node_backend import ServerDaemonNodeBackend
from ..security.rate_limit import AuthRateLimiter
from ..tasks.scheduler import TaskScheduler
from ..automations.service import AutomationService, max_runs_per_hour_from_env
from ..persistence.automation.store import DatabaseAutomationStore
from ..core.settings import AppSettings, RateLimit
from ..persistence.protocols import (
    ManagedNodeStore,
    OrgSettingsStore,
    ProjectStore,
    SessionStore,
    TaskStore,
    TeamStore,
)


def task_scheduler_from_env(
    *,
    session_store: SessionStore,
    automation_store: DatabaseAutomationStore,
    task_store: TaskStore,
    registry: DaemonNodeRegistry,
    backend: ServerDaemonNodeBackend,
    team_store: TeamStore,
    project_store: ProjectStore,
    managed_node_store: ManagedNodeStore | None = None,
    org_settings_store: OrgSettingsStore | None = None,
    today: Callable[[], date] | None = None,
    settings: AppSettings | None = None,
) -> TaskScheduler | None:
    settings = settings or AppSettings.from_env()
    if not settings.task_scheduler_enabled:
        return None
    # The automation store is database-only and always present, so every
    # scheduler runs the automation tick.
    automations = AutomationService(
        task_store=task_store, session_store=session_store, automation_store=automation_store,
        project_store=project_store, max_runs_per_hour=max_runs_per_hour_from_env(),
        batch=settings.automation_outbox_batch,
    )
    return TaskScheduler(
        automations=automations,
        task_store=task_store,
        registry=registry,
        backend=backend,
        team_store=team_store,
        project_store=project_store,
        managed_node_store=managed_node_store,
        org_settings_store=org_settings_store,
        interval_seconds=settings.task_scheduler_interval_seconds,
        max_dispatches_per_tick=settings.task_scheduler_max_dispatches,
        today=today or settings.scheduler_today,
    )


def rate_limiter(limit: RateLimit) -> AuthRateLimiter:
    return AuthRateLimiter(attempts=limit.attempts, window_seconds=limit.window_seconds)
