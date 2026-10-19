from __future__ import annotations

import asyncio
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from datetime import date
from typing import Annotated, Any

from fastapi import Depends, Request

from ..chat.integrations import DatabaseChatIntegrationStore
from ..daemon_registry.registry import DaemonNodeRegistry
from ..daemon_registry.node_backend import ServerDaemonNodeBackend
from ..persistence.protocols import (
    AgentPlacementStore,
    AgentStore,
    AuthStore,
    DaemonStore,
    OrgSettingsStore,
    ProjectStore,
    SessionStore,
    TaskStore,
    TeamStore,
)
from ..persistence.account.profile_images import DatabaseProfileImageStore
from ..persistence.skill.store import DatabaseSkillStore
from ..realtime.event_notifier import KeyedEventNotifier, PostgresNotificationBridge
from ..computer.workspace_query import WorkspaceQueryBroker
from ..persistence.daemon.managed_nodes import DatabaseManagedNodeStore
from ..persistence.automation.store import DatabaseAutomationStore
from ..persistence.notification.store import DatabaseNotificationStore
from ..core.settings import AppSettings
from ..security.rate_limit import AuthRateLimiter
from ..execution.lifecycle import ExecutionLifecycleService
from ..accounts.password_reset import PasswordResetService
from ..accounts.waitlist import WaitlistService

ChatProbe = Callable[[dict[str, Any]], Awaitable[tuple[bool, str]]]
ChatProvision = Callable[[dict[str, Any], str], Awaitable[tuple[bool, str]]]


@dataclass(frozen=True)
class AppContext:
    session_store: SessionStore
    task_store: TaskStore
    daemon_store: DaemonStore
    # Concrete: routes use the integration admin surface, which the read-only
    # ``ChatStore`` protocol does not declare; every store subclasses this one.
    chat_store: DatabaseChatIntegrationStore
    registry: DaemonNodeRegistry
    backend: ServerDaemonNodeBackend
    auth_store: AuthStore
    managed_node_store: DatabaseManagedNodeStore
    agent_store: AgentStore
    team_store: TeamStore
    project_store: ProjectStore
    skill_store: DatabaseSkillStore
    agent_placement_store: AgentPlacementStore
    # Concrete, as the app builds it: ``ProfileImageStore`` in the protocols
    # module disagrees with the store's real save/read signatures.
    profile_image_store: DatabaseProfileImageStore
    org_settings_store: OrgSettingsStore
    workspace_query_broker: WorkspaceQueryBroker
    control_plane_notifier: KeyedEventNotifier
    today: Callable[[], date]
    settings: AppSettings
    automation_store: DatabaseAutomationStore
    notification_store: DatabaseNotificationStore
    execution_lifecycle: ExecutionLifecycleService
    # None when the database has no LISTEN/NOTIFY bridge (SQLite).
    notification_bridge: PostgresNotificationBridge | None
    # Always built: admins invite by email on every install. RELAY_WAITLIST_ENABLED
    # gates only the public join route.
    waitlist: WaitlistService
    password_reset: PasswordResetService
    auth_rate_limiter: AuthRateLimiter
    automation_webhook_limiter: AuthRateLimiter
    automation_webhook_failure_limiter: AuthRateLimiter
    waitlist_rate_limiter: AuthRateLimiter
    password_reset_rate_limiter: AuthRateLimiter
    chat_probe: ChatProbe
    chat_provision: ChatProvision
    # Shared and mutable on purpose: one lock per integration, process-wide.
    chat_rotation_locks: dict[str, asyncio.Lock]


def app_context(request: Request) -> AppContext:
    """The context ``create_app`` built once at startup (``app.state.context``).

    Every API module reaches application state through this, never through
    ``request.app.state`` directly (``tests/unit/test_api_state_access.py``).
    """
    context: AppContext = request.app.state.context
    return context


AppContextDep = Annotated[AppContext, Depends(app_context)]
