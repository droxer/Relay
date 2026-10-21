from __future__ import annotations

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from pathlib import Path
from dataclasses import fields
from typing import Any, cast

from fastapi import FastAPI
from loguru import logger

from .api.accounts import (
    auth as auth_routes,
    notifications as notification_routes,
    password_reset as password_reset_routes,
    profile_images as profile_image_routes,
    users as admin_user_routes,
    waitlist as waitlist_routes,
)
from .api.admin import dashboard as admin_dashboard_routes, settings as admin_settings_routes
from .api.agents import agents as agent_routes, skills as skill_routes, teams as team_routes
from .api.chat import gateway as chat_gateway_routes, integrations as chat_integration_routes
from .api.computers import (
    admin_nodes as admin_node_routes,
    daemon_wire as daemon_wire_routes,
    device_authorizations as device_authorization_routes,
    enrollment as enrollment_routes,
    installer as computer_installer_routes,
    managed_nodes as managed_node_routes,
    node_workspace as node_workspace_routes,
    sandboxes as sandbox_routes,
    user_nodes as user_node_routes,
)
from .api.projects import projects as project_routes
from .api.tasks import (
    automations as automation_routes,
    history as task_history_routes,
    records as task_record_routes,
    runs as task_run_routes,
    workspace_files as task_workspace_routes,
)
from .api.threads import (
    artifacts as thread_artifact_routes,
    decisions as thread_decision_routes,
    events as thread_event_routes,
    lifecycle as thread_lifecycle_routes,
    messages as thread_message_routes,
    reads as thread_read_routes,
)
from .api.web import routes as web_routes
from .api.conditional_get import ConditionalGetMiddleware
from .api.deps import AppContext
from .api.contract import (
    API_DOCS_PATH,
    API_OPENAPI_PATH,
    API_PREFIX,
    API_REDOC_PATH,
    API_VERSION,
    api_router_groups,
    include_api_router,
)
from .chat.provider_health import probe_chat_integration, provision_chat_integration
from .core import deploy_config
from .core.environment import load_backend_env
from .daemon_registry.registry import DaemonNodeRegistry
from .daemon_registry.node_backend import ServerDaemonNodeBackend
from .core.environment import DEFAULT_RELAY_DATA_DIR
from .notifications.watcher import ComputerNotificationWatcher, watch_interval_from_env
from .security.edge import EdgeOriginGuardMiddleware
from .security.rate_limit import AuthRateLimiter
from .chat.integrations import DatabaseChatIntegrationStore
from .realtime.event_notifier import (
    CONTROL_PLANE_NOTIFICATION_CHANNEL,
    KeyedEventNotifier,
    PostgresNotificationBridge,
    daemon_command_key,
    database_notification_bridge,
    session_event_key,
    workspace_response_key,
)
from .accounts.password_reset import PasswordResetService, password_reset_config_from_env
from .security.password_resets import password_reset_store_for
from .notifications.mailer import mailer_from_env
from .computer.workspace_query import WorkspaceQueryBroker
from .accounts.waitlist import WaitlistService
from .persistence.task.lifecycle import wip_limit
from .execution.lifecycle import ExecutionLifecycleService
from .core.settings import AppSettings
from .migrations_runtime.startup import (
    migrate_legacy_computer_ids,
    repair_records_before_serving,
)
from .bootstrap.http import (
    CookieRequestGuardMiddleware,
    SecurityHeadersMiddleware,
    ServerTimingMiddleware,
    unhandled_error,
    configure_cors,
)
from .bootstrap.stores import (
    waitlist_service_from_env,
    Stores,
    build_stores,
)
from .bootstrap.runtime import rate_limiter, task_scheduler_from_env

load_backend_env()

WEB_UI_PATH = "/"


def create_app(
    root_dir: str | Path = DEFAULT_RELAY_DATA_DIR,
    *,
    background_mode: str | None = None,
) -> FastAPI:
    settings = AppSettings.from_env()  # Every bad value at once, before any service starts.
    _validate_deploy_config()
    # "external": a separate `relay worker` owns the scheduler, recovery, and
    # computer-notification loops, so this process starts none of them.
    mode = background_mode if background_mode is not None else settings.background_mode
    if mode not in ("embedded", "external"):
        raise ValueError("background_mode must be embedded or external.")
    root_dir = Path(root_dir)
    logger.info("Relay backend starting", root_dir=str(root_dir))
    stores = build_stores(root_dir, managed_node_provider=settings.managed_node_provider)
    # One mailer for every transactional email; a half-configured mail setup
    # fails startup here rather than silently dropping invites and resets.
    mailer = mailer_from_env()
    waitlist = waitlist_service_from_env(mailer)
    password_reset = PasswordResetService(
        password_reset_store_for(stores.auth), mailer, config=password_reset_config_from_env()
    )
    notifier = KeyedEventNotifier()
    notification_bridge = database_notification_bridge(stores.sessions, notifier)
    _publish_store_changes(stores, notifier)
    if settings.startup_repairs_enabled:
        repair_records_before_serving(
            team_store=stores.teams, agent_store=stores.agents, agent_placement_store=stores.placements
        )
    registry = DaemonNodeRegistry(
        stores.sessions,
        stores.daemon,
        task_store=stores.tasks,
        project_store=stores.projects,
        notification_store=stores.notifications,
    )
    backend = ServerDaemonNodeBackend(
        registry,
        agent_store=stores.agents,
        agent_placement_store=stores.placements,
        skill_store=stores.skills,
        team_store=stores.teams,
        project_store=stores.projects,
    )
    if settings.startup_repairs_enabled:
        migrate_legacy_computer_ids(
            agent_store=stores.agents, agent_placement_store=stores.placements, registry=registry
        )
    scheduler = task_scheduler_from_env(
        settings=settings,
        session_store=stores.sessions,
        automation_store=stores.automations,
        task_store=stores.tasks,
        registry=registry,
        backend=backend,
        team_store=stores.teams,
        project_store=stores.projects,
        managed_node_store=stores.managed_nodes,
        org_settings_store=stores.org_settings,
        today=settings.scheduler_today,
    )
    if scheduler is None:
        # Without a scheduler nothing drains the automation outbox.
        stores.tasks.emit_automation_events = False
        stores.sessions.emit_automation_events = False
    execution_lifecycle = ExecutionLifecycleService(registry, stores.chat)
    computer_notifications = ComputerNotificationWatcher(
        registry, stores.auth, stores.notifications, interval_seconds=watch_interval_from_env(),
    )
    loops = (execution_lifecycle, computer_notifications, scheduler) if mode == "embedded" else ()
    services = [service for service in (notification_bridge, *loops) if service]

    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        computer_installer_routes.warn_if_bundle_stale(settings.computer_bundle)
        for service in services:
            service.start()
        try:
            yield
        finally:
            for service in reversed(services):
                await service.stop()
            notifier.close()

    app = FastAPI(
        title="Relay backend",
        version="0.1.0",
        lifespan=lifespan,
        docs_url=API_DOCS_PATH,
        openapi_url=API_OPENAPI_PATH,
        redoc_url=API_REDOC_PATH,
    )
    _install_http_edge(app)
    _publish_state(
        app,
        settings=settings,
        stores=stores,
        registry=registry,
        backend=backend,
        scheduler=scheduler,
        execution_lifecycle=execution_lifecycle,
        computer_notifications=computer_notifications,
        notifier=notifier,
        notification_bridge=notification_bridge,
        waitlist=waitlist,
        password_reset=password_reset,
    )
    _mount_routes(app, settings)
    return app


def _validate_deploy_config() -> None:
    wip_limit()  # Validate the shared admission policy before starting services.
    deploy_config.public_backend_url()  # Fail before enrollment can emit a bad URL.
    deploy_config.public_web_url()
    deploy_config.edge_secrets()  # Fail before a weak origin lock goes live.
    deploy_config.client_ip_header()


def _publish_store_changes(stores: Stores, notifier: KeyedEventNotifier) -> None:
    """Wake waiting requests (SSE, daemon long-polls) when a store commits."""
    stores.sessions.set_event_listener(
        lambda session_id: notifier.publish(session_event_key(session_id)),
        database_channel=CONTROL_PLANE_NOTIFICATION_CHANNEL,
    )
    stores.daemon.set_command_listener(
        lambda node_id: notifier.publish(daemon_command_key(node_id)),
        database_channel=CONTROL_PLANE_NOTIFICATION_CHANNEL,
    )
    stores.daemon.set_workspace_listener(
        lambda command_id: notifier.publish(workspace_response_key(command_id)),
        database_channel=CONTROL_PLANE_NOTIFICATION_CHANNEL,
    )


def _install_http_edge(app: FastAPI) -> None:
    app.add_exception_handler(Exception, unhandled_error)
    # Innermost of these, so SecurityHeadersMiddleware sees the polled lists'
    # `private, no-cache` and leaves it instead of forcing no-store.
    app.add_middleware(ConditionalGetMiddleware)
    app.add_middleware(ServerTimingMiddleware)
    app.add_middleware(CookieRequestGuardMiddleware)
    app.add_middleware(SecurityHeadersMiddleware)
    configure_cors(app)
    if deploy_config.edge_secrets():
        # Added last so it runs first: nothing behind it sees an unproven request.
        app.add_middleware(EdgeOriginGuardMiddleware)


def _publish_state(
    app: FastAPI,
    *,
    settings: AppSettings,
    stores: Stores,
    registry: DaemonNodeRegistry,
    backend: ServerDaemonNodeBackend,
    scheduler: Any,
    execution_lifecycle: ExecutionLifecycleService,
    computer_notifications: ComputerNotificationWatcher,
    notifier: KeyedEventNotifier,
    notification_bridge: PostgresNotificationBridge | None,
    waitlist: WaitlistService,
    password_reset: PasswordResetService,
) -> None:
    """Build the one ``AppContext`` request handlers read (see api/deps.py).

    The individual ``app.state`` attributes below are the same objects the
    context holds, kept for the CLI and tests; API modules read only the
    context, so replacing one of these attributes after startup does not
    reach a route — replace ``app.state.context`` instead.
    """
    context = AppContext(
        session_store=stores.sessions,
        task_store=stores.tasks,
        daemon_store=stores.daemon,
        chat_store=cast(DatabaseChatIntegrationStore, stores.chat),
        registry=registry,
        backend=backend,
        auth_store=stores.auth,
        managed_node_store=stores.managed_nodes,
        agent_store=stores.agents,
        team_store=stores.teams,
        project_store=stores.projects,
        skill_store=stores.skills,
        agent_placement_store=stores.placements,
        profile_image_store=stores.profile_images,
        org_settings_store=stores.org_settings,
        workspace_query_broker=WorkspaceQueryBroker(),
        control_plane_notifier=notifier,
        today=settings.scheduler_today,
        settings=settings,
        automation_store=stores.automations,
        notification_store=stores.notifications,
        execution_lifecycle=execution_lifecycle,
        notification_bridge=notification_bridge,
        waitlist=waitlist,
        password_reset=password_reset,
        auth_rate_limiter=AuthRateLimiter(),
        automation_webhook_limiter=rate_limiter(settings.automation_webhook_limit),
        automation_webhook_failure_limiter=rate_limiter(settings.automation_webhook_failure_limit),
        waitlist_rate_limiter=rate_limiter(settings.waitlist_limit),
        password_reset_rate_limiter=rate_limiter(settings.password_reset_limit),
        chat_probe=probe_chat_integration,
        chat_provision=provision_chat_integration,
        chat_rotation_locks={},
    )
    state = app.state
    state.context = context
    for field in fields(context):
        setattr(state, field.name, getattr(context, field.name))
    state.task_scheduler = scheduler
    state.computer_notifications = computer_notifications

# Order matters: within each router group, a route registered earlier wins a
# path both could match. A domain split across modules lists its routers in
# the order its routes were declared.
API_ROUTERS = (
    automation_routes.router,
    auth_routes.router,
    device_authorization_routes.router,
    agent_routes.router,
    team_routes.router,
    project_routes.router,
    skill_routes.router,
    node_workspace_routes.router,
    admin_settings_routes.router,
    admin_user_routes.router,
    admin_node_routes.router,
    chat_integration_routes.router,
    admin_dashboard_routes.router,
    chat_gateway_routes.router,
    thread_message_routes.router,
    task_record_routes.router,
    task_run_routes.router,
    task_history_routes.router,
    task_workspace_routes.router,
    thread_read_routes.router,
    thread_lifecycle_routes.router,
    thread_decision_routes.router,
    thread_event_routes.router,
    thread_artifact_routes.router,
    sandbox_routes.router,
    user_node_routes.router,
    enrollment_routes.router,
    daemon_wire_routes.router,
    managed_node_routes.router,
    notification_routes.router,
    password_reset_routes.router,
    waitlist_routes.router,
)


def _mount_routes(app: FastAPI, settings: AppSettings) -> None:
    # Platform health checks run before the app has a database session and must
    # never require auth, so this stays outside the versioned API namespace and
    # reports only liveness.
    @app.get("/healthz", tags=["api"], include_in_schema=False)
    async def healthz() -> dict[str, str]:
        return {"status": "ok", "version": API_VERSION}

    @app.get("/api", tags=["api"])
    async def api_info() -> dict[str, Any]:
        return {
            "name": "Relay backend",
            "version": API_VERSION,
            "basePath": API_PREFIX,
            "docsPath": API_DOCS_PATH,
            "openapiPath": API_OPENAPI_PATH,
            "redocPath": API_REDOC_PATH,
            "uiPath": "/admin",
            "webUiPath": WEB_UI_PATH,
        }

    groups = api_router_groups()
    for router in API_ROUTERS:
        include_api_router(
            groups,
            router,
            channels_enabled=settings.channels_enabled,
            waitlist_enabled=settings.waitlist_enabled,
        )
    app.include_router(groups.public)
    app.include_router(groups.admin)
    app.include_router(groups.internal_chat)
    app.include_router(groups.daemon)
    # Stable persisted media locators intentionally remain outside the JSON API
    # namespace because their URLs are persisted data.
    app.include_router(profile_image_routes.router, tags=["profile-images"])
    # Public downloads are served at the API origin, ahead of the SPA fallback.
    app.include_router(computer_installer_routes.router)
    # Registered last: its root catch-all serves the exported web UI and must not
    # shadow the explicit API routes above.
    app.include_router(web_routes.router)
