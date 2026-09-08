from __future__ import annotations

import os
import re
import time
from collections.abc import AsyncIterator, Callable
from contextlib import asynccontextmanager
from datetime import date, datetime
from pathlib import Path
from typing import Any, ClassVar
from zoneinfo import ZoneInfo

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from loguru import logger
from starlette.responses import JSONResponse
from starlette.types import ASGIApp, Message, Receive, Scope, Send

from .api import (
    admin_routes,
    agent_routes,
    auth_routes,
    chat_routes,
    collaboration_routes,
    daemon_node_routes,
    managed_node_routes,
    node_workspace_routes,
    profile_image_routes,
    project_routes,
    sandbox_routes,
    session_routes,
    task_routes,
    team_routes,
    web_routes,
)
from .api.contract import (
    API_DOCS_PATH,
    API_OPENAPI_PATH,
    API_PREFIX,
    API_REDOC_PATH,
    API_VERSION,
    api_router_groups,
    include_api_router,
)
from .chat import (
    DatabaseChatIntegrationStore,
    LocalChatIntegrationStore,
    probe_chat_integration,
    provision_chat_integration,
)
from .core import deploy_config
from .core.environment import load_backend_env
from .core.storage_config import database_url_from_env, use_postgres_storage
from .daemon_registry import DaemonNodeRegistry, ServerDaemonNodeBackend
from .migrations_runtime.agent_computer_id import (
    migrate_agent_computer_ids,
    migrate_agent_placement_computer_ids,
)
from .persistence.agent_placement_store import (
    DatabaseAgentPlacementStore,
    LocalAgentPlacementStore,
    reconcile_single_active_placement,
)
from .persistence.agent_store import DatabaseAgentStore, LocalAgentStore
from .persistence.org_settings_store import DatabaseOrgSettingsStore
from .persistence.profile_image_store import LocalProfileImageStore
from .persistence.project_store import DatabaseProjectStore
from .persistence.stores import (
    DEFAULT_RELAY_DATA_DIR,
    DatabaseDaemonStore,
    DatabaseSessionStore,
    DatabaseTaskStore,
    LocalDaemonStore,
)
from .persistence.team_store import DatabaseTeamStore, LocalTeamStore
from .security.auth import USER_COOKIE_NAME, auth_store_from_env, configure_admin_token
from .security.rate_limit import AuthRateLimiter
from .services.dispatch_retry import DEFAULT_MAX_CONSECUTIVE_DISPATCH_FAILURES
from .services.event_notifier import (
    CONTROL_PLANE_NOTIFICATION_CHANNEL,
    KeyedEventNotifier,
    daemon_command_key,
    database_notification_bridge,
    session_event_key,
    workspace_response_key,
)
from .services.managed_nodes import LocalManagedNodeStore
from .services.team_membership import reconcile_team_memberships
from .services.workspace_query import WorkspaceQueryBroker
from .tasks import TaskScheduler

load_backend_env()

CONTROL_PANEL_VERSION = os.environ.get("RELAY_CONTROL_PANEL_VERSION") or "python"
WEB_UI_PATH = "/"


class ServerTimingMiddleware:
    """Expose backend time-to-response-headers without buffering response bodies."""

    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        started_at = time.perf_counter()

        async def send_with_timing(message: Message) -> None:
            if message["type"] == "http.response.start":
                duration_ms = (time.perf_counter() - started_at) * 1000
                headers = list(message.get("headers", []))
                headers.append(
                    (b"server-timing", f"app;dur={duration_ms:.2f}".encode("ascii"))
                )
                message = {**message, "headers": headers}
            await send(message)

        await self.app(scope, receive, send_with_timing)


class CookieRequestGuardMiddleware:
    """Reject cross-site mutations that carry a browser session cookie."""

    _unsafe_methods: ClassVar[set[str]] = {"POST", "PUT", "PATCH", "DELETE"}

    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http" or scope.get("method") not in self._unsafe_methods:
            await self.app(scope, receive, send)
            return
        headers = {
            key.decode("latin-1").lower(): value.decode("latin-1")
            for key, value in scope.get("headers", [])
        }
        cookie = headers.get("cookie", "")
        if f"{USER_COOKIE_NAME}=" not in cookie:
            await self.app(scope, receive, send)
            return
        origin = headers.get("origin", "").rstrip("/")
        fetch_site = headers.get("sec-fetch-site", "").lower()
        origin_allowed = origin and _request_origin_allowed(scope, headers, origin)
        # A same-origin browser request can reach Relay through the Next.js
        # rewrite proxy with the public Origin preserved but the upstream Host
        # substituted. Sec-Fetch-Site is browser-controlled, so it identifies
        # that safe proxy case without trusting spoofable X-Forwarded-* values.
        if (origin and not origin_allowed and fetch_site != "same-origin") or (
            not origin and fetch_site == "cross-site"
        ):
            response = JSONResponse(
                {"detail": "Cross-site request rejected."}, status_code=403
            )
            await response(scope, receive, send)
            return
        await self.app(scope, receive, send)


def _request_origin_allowed(scope: Scope, headers: dict[str, str], origin: str) -> bool:
    host = headers.get("host", "")
    if host and origin == f"{scope.get('scheme', 'http')}://{host}":
        return True
    if origin in deploy_config.cors_allow_origins():
        return True
    pattern = deploy_config.cors_allow_origin_regex()
    return bool(pattern and re.fullmatch(pattern, origin))


class SecurityHeadersMiddleware:
    """Apply one browser hardening policy to API and backend-served UI."""

    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        async def send_with_security_headers(message: Message) -> None:
            if message["type"] == "http.response.start":
                headers = list(message.get("headers", []))
                existing = {key.lower() for key, _value in headers}

                def add(key: bytes, value: bytes) -> None:
                    if key.lower() not in existing:
                        headers.append((key, value))

                add(b"x-content-type-options", b"nosniff")
                add(b"x-frame-options", b"DENY")
                add(b"referrer-policy", b"strict-origin-when-cross-origin")
                add(
                    b"content-security-policy",
                    b"base-uri 'self'; object-src 'none'; frame-ancestors 'none'",
                )
                add(
                    b"permissions-policy",
                    b"camera=(), microphone=(), geolocation=()",
                )
                if str(scope.get("path", "")).startswith("/api"):
                    add(b"cache-control", b"no-store")
                if scope.get("scheme") == "https":
                    add(
                        b"strict-transport-security",
                        b"max-age=31536000; includeSubDomains",
                    )
                message = {**message, "headers": headers}
            await send(message)

        await self.app(scope, receive, send_with_security_headers)


def create_app(root_dir: str | Path = DEFAULT_RELAY_DATA_DIR) -> FastAPI:
    root_dir = Path(root_dir)
    logger.info("Relay backend starting", root_dir=str(root_dir))
    configure_admin_token(root_dir)

    session_store = session_store_from_env(root_dir)
    task_store = task_store_from_env(root_dir)
    daemon_store = daemon_store_from_env(root_dir)
    chat_store = chat_store_from_env(root_dir)
    auth_store = auth_store_from_env(root_dir)
    managed_node_store = LocalManagedNodeStore(root_dir)
    agent_store = agent_store_from_env(root_dir)
    team_store = team_store_from_env(root_dir)
    project_store = project_store_from_env(root_dir)
    agent_placement_store = agent_placement_store_from_env(root_dir)
    profile_image_store = LocalProfileImageStore(root_dir)
    org_settings_store = org_settings_store_from_env(root_dir)
    control_plane_notifier = KeyedEventNotifier()
    notification_bridge = database_notification_bridge(
        session_store, control_plane_notifier
    )
    session_store.set_event_listener(
        lambda session_id: control_plane_notifier.publish(
            session_event_key(session_id)
        ),
        database_channel=CONTROL_PLANE_NOTIFICATION_CHANNEL,
    )
    if hasattr(daemon_store, "set_command_listener"):
        daemon_store.set_command_listener(
            lambda node_id: control_plane_notifier.publish(daemon_command_key(node_id)),
            database_channel=CONTROL_PLANE_NOTIFICATION_CHANNEL,
        )
    if hasattr(daemon_store, "set_workspace_listener"):
        daemon_store.set_workspace_listener(
            lambda command_id: control_plane_notifier.publish(
                workspace_response_key(command_id)
            ),
            database_channel=CONTROL_PLANE_NOTIFICATION_CHANNEL,
        )
    # Older runtimes could retire an agent without updating Teams. Repair those
    # dangling member references through Team events before serving requests.
    reconcile_team_memberships(team_store, agent_store)
    # Heal any agent left with multiple active placements before the
    # one-agent-one-computer invariant (idempotent; a no-op once collapsed).
    reconcile_single_active_placement(agent_placement_store)
    registry = DaemonNodeRegistry(session_store, daemon_store, task_store=task_store)
    backend = ServerDaemonNodeBackend(
        registry,
        agent_store=agent_store,
        agent_placement_store=agent_placement_store,
    )
    try:
        migrated_placements = migrate_agent_placement_computer_ids(
            agent_placement_store, registry
        )
        if migrated_placements:
            logger.info(
                "Migrated legacy agent placement computer ids",
                count=migrated_placements,
            )
        migrated = migrate_agent_computer_ids(
            agent_store, agent_placement_store, registry
        )
        if migrated:
            logger.info("Migrated compatibility agents", count=migrated)
    except Exception as error:  # noqa: BLE001 - migration failure must not block startup
        logger.warning("Agent computer-id migration deferred", error=str(error))

    today = scheduler_today_from_env()
    scheduler = task_scheduler_from_env(
        task_store=task_store,
        registry=registry,
        backend=backend,
        team_store=team_store,
        project_store=project_store,
        managed_node_store=managed_node_store,
        org_settings_store=org_settings_store,
        today=today,
    )

    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        if notification_bridge:
            notification_bridge.start()
        if scheduler:
            scheduler.start()
        try:
            yield
        finally:
            if scheduler:
                await scheduler.stop()
            if notification_bridge:
                await notification_bridge.stop()
            control_plane_notifier.close()

    app = FastAPI(
        title="Relay backend",
        version="0.1.0",
        lifespan=lifespan,
        docs_url=API_DOCS_PATH,
        openapi_url=API_OPENAPI_PATH,
        redoc_url=API_REDOC_PATH,
    )
    app.add_middleware(ServerTimingMiddleware)
    app.add_middleware(CookieRequestGuardMiddleware)
    app.add_middleware(SecurityHeadersMiddleware)
    _configure_cors(app)
    app.state.session_store = session_store
    app.state.task_store = task_store
    app.state.daemon_store = daemon_store
    app.state.chat_store = chat_store
    app.state.chat_probe = probe_chat_integration
    app.state.chat_provision = provision_chat_integration
    app.state.chat_rotation_locks = {}
    app.state.registry = registry
    app.state.backend = backend
    app.state.auth_store = auth_store
    app.state.auth_rate_limiter = AuthRateLimiter()
    app.state.managed_node_store = managed_node_store
    app.state.agent_store = agent_store
    app.state.team_store = team_store
    app.state.project_store = project_store
    app.state.employee_agent_store = (
        agent_store  # compatibility for migrations still reading the old name
    )
    app.state.agent_placement_store = agent_placement_store
    app.state.profile_image_store = profile_image_store
    app.state.org_settings_store = org_settings_store
    app.state.workspace_query_broker = WorkspaceQueryBroker()
    app.state.control_plane_notifier = control_plane_notifier
    app.state.notification_bridge = notification_bridge
    app.state.task_scheduler = scheduler
    app.state.today = today
    app.state.control_panel_version = CONTROL_PANEL_VERSION

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

    api_routers = (
        auth_routes.router,
        agent_routes.router,
        team_routes.router,
        project_routes.router,
        node_workspace_routes.router,
        admin_routes.router,
        chat_routes.router,
        collaboration_routes.router,
        task_routes.router,
        session_routes.router,
        sandbox_routes.router,
        daemon_node_routes.router,
        managed_node_routes.router,
    )
    canonical_groups = api_router_groups()
    for router in api_routers:
        include_api_router(canonical_groups, router)
    app.include_router(canonical_groups.public)
    app.include_router(canonical_groups.admin)
    app.include_router(canonical_groups.internal_chat)
    app.include_router(canonical_groups.daemon)

    # Stable persisted media locators intentionally remain outside the JSON API
    # namespace because their URLs are persisted data.
    app.include_router(profile_image_routes.router, tags=["profile-images"])

    # Registered last: its root catch-all serves the exported web UI and must not
    # shadow the explicit API routes above.
    app.include_router(web_routes.router)
    return app


def _configure_cors(app: FastAPI) -> None:
    """Allow a separately hosted web UI to call the API with session cookies.

    A no-op unless origins are configured, which keeps the single-origin
    deployment free of CORS headers it does not need. ``allow_credentials`` is
    required because Relay authenticates with a cookie, and it is what forces
    the exact-origin rule enforced in ``deploy_config.cors_allow_origins``.
    """
    if not deploy_config.cors_enabled():
        return
    origins = deploy_config.cors_allow_origins()
    origin_regex = deploy_config.cors_allow_origin_regex()
    app.add_middleware(
        CORSMiddleware,
        allow_origins=origins,
        allow_origin_regex=origin_regex,
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
        # The web client reads Last-Event-ID off SSE frames, not headers, but
        # Server-Timing is read by the browser devtools panel on every request.
        expose_headers=["Server-Timing"],
    )
    logger.info(
        "CORS enabled for cross-origin web UI",
        origins=origins,
        origin_regex=origin_regex,
    )


def daemon_store_from_env(root_dir: Path) -> Any:
    daemon_store = os.environ.get("RELAY_DAEMON_STORE", "").strip().lower()
    if daemon_store != "database" and not use_postgres_storage():
        return LocalDaemonStore(root_dir)
    setting = (
        "RELAY_DAEMON_STORE=database"
        if daemon_store == "database"
        else "RELAY_STORAGE=postgres"
    )
    database_url = database_url_from_env(setting=setting)
    return DatabaseDaemonStore(database_url)


def agent_store_from_env(root_dir: Path) -> Any:
    if not use_postgres_storage():
        return LocalAgentStore(root_dir)
    return DatabaseAgentStore(database_url_from_env(setting="RELAY_STORAGE=postgres"))


def org_settings_store_from_env(root_dir: Path) -> Any:
    # Database-only, like sessions and tasks: a database engine always exists,
    # so a file-backed twin would only be a second code path to keep in sync.
    database_url = database_url_from_env(setting="database-only settings storage")
    return DatabaseOrgSettingsStore(
        database_url, create_schema=database_url.startswith("sqlite")
    )


def team_store_from_env(root_dir: Path) -> Any:
    if not use_postgres_storage():
        return LocalTeamStore(root_dir)
    return DatabaseTeamStore(database_url_from_env(setting="RELAY_STORAGE=postgres"))


def project_store_from_env(root_dir: Path) -> Any:
    database_url = database_url_from_env(setting="database-only project storage")
    return DatabaseProjectStore(
        database_url, create_schema=database_url.startswith("sqlite")
    )


def agent_placement_store_from_env(root_dir: Path) -> Any:
    if not use_postgres_storage():
        return LocalAgentPlacementStore(root_dir)
    return DatabaseAgentPlacementStore(
        database_url_from_env(setting="RELAY_STORAGE=postgres")
    )


def session_store_from_env(root_dir: Path) -> Any:
    database_url = database_url_from_env(setting="database-only thread storage")
    store = DatabaseSessionStore(
        database_url,
        create_schema=database_url.startswith("sqlite"),
    )
    store.verify_schema()
    return store


def task_store_from_env(root_dir: Path) -> Any:
    database_url = database_url_from_env(setting="database-only thread storage")
    store = DatabaseTaskStore(
        database_url,
        create_schema=database_url.startswith("sqlite"),
    )
    store.verify_schema()
    return store


def chat_store_from_env(root_dir: Path) -> Any:
    chat_store = os.environ.get("RELAY_CHAT_STORE", "").strip().lower()
    if chat_store != "database" and not use_postgres_storage():
        return LocalChatIntegrationStore(root_dir)
    setting = (
        "RELAY_CHAT_STORE=database"
        if chat_store == "database"
        else "RELAY_STORAGE=postgres"
    )
    return DatabaseChatIntegrationStore(database_url_from_env(setting=setting))


def task_scheduler_from_env(
    *,
    task_store: Any,
    registry: DaemonNodeRegistry,
    backend: ServerDaemonNodeBackend,
    team_store: Any,
    project_store: Any,
    managed_node_store: Any | None = None,
    org_settings_store: Any | None = None,
    today: Callable[[], date] | None = None,
) -> TaskScheduler | None:
    enabled = os.environ.get("RELAY_TASK_SCHEDULER_ENABLED", "1").strip().lower()
    if enabled in ("0", "false", "no", "off"):
        return None
    return TaskScheduler(
        task_store=task_store,
        registry=registry,
        backend=backend,
        team_store=team_store,
        project_store=project_store,
        managed_node_store=managed_node_store,
        org_settings_store=org_settings_store,
        interval_seconds=float(
            os.environ.get("RELAY_TASK_SCHEDULER_INTERVAL_SECONDS", "10")
        ),
        max_dispatches_per_tick=max(
            1, int(os.environ.get("RELAY_TASK_SCHEDULER_MAX_DISPATCHES", "5"))
        ),
        max_dispatch_failures=max(
            1,
            int(
                os.environ.get(
                    "RELAY_TASK_DISPATCH_MAX_FAILURES",
                    str(DEFAULT_MAX_CONSECUTIVE_DISPATCH_FAILURES),
                )
            ),
        ),
        today=today or scheduler_today_from_env(),
    )


def scheduler_today_from_env() -> Callable[[], date]:
    """Routine due dates are calendar days; without a configured timezone they
    roll over at server-local midnight, which surprises users in other zones."""
    timezone_name = os.environ.get("RELAY_TASK_SCHEDULER_TIMEZONE", "").strip()
    if not timezone_name:
        return date.today
    zone = ZoneInfo(timezone_name)  # invalid names fail fast at startup
    return lambda: datetime.now(zone).date()
