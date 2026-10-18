"""Which store backs each aggregate, chosen from the environment once at startup.
"""

from __future__ import annotations

from pathlib import Path
import os

from loguru import logger

from ..chat.integrations import DatabaseChatIntegrationStore
from ..core.storage_config import database_url_from_env
from ..persistence.agent_placement_store import DatabaseAgentPlacementStore
from ..persistence.agent_store import DatabaseAgentStore
from ..persistence.blob_store import (
    BlobStore,
    blob_store_from_env,
)
from ..persistence.admin_token_store import DatabaseAdminTokenStore
from ..persistence.org_settings_store import DatabaseOrgSettingsStore
from ..persistence.project_store import DatabaseProjectStore
from ..persistence.skill_store import DatabaseSkillStore
from ..persistence.skill_object_store import BlobSkillObjectStore, LocalSkillObjectStore
from ..persistence.stores import (
    DatabaseDaemonStore,
    DatabaseSessionStore,
    DatabaseTaskStore,
)
from ..persistence.team_store import DatabaseTeamStore
from ..persistence.waitlist_store import DatabaseWaitlistStore
from ..persistence.notification_store import DatabaseNotificationStore
from ..services.waitlist import WaitlistService, waitlist_config_from_env
from ..notifications.mailer import Mailer
from ..persistence.automation_store import DatabaseAutomationStore
from ..persistence.protocols import (
    AgentPlacementStore,
    AgentStore,
    ChatStore,
    DaemonStore,
    TeamStore,
)
from ..persistence.managed_node_store import DatabaseManagedNodeStore
from ..persistence.profile_image_store import DatabaseProfileImageStore
from ..security.auth import (
    DatabaseAccountAuthStore,
    auth_store_from_env,
    configure_admin_token,
)
from dataclasses import dataclass


# Accounts, daemon, agent, team, placement, and chat state used to have
# file-backed twins selected by these variables. They are database-only now;
# any existing JSON under the data directory is imported once at boot
# (relay/security/auth_file_import.py, relay/persistence/file_store_import.py).
RETIRED_STORE_SETTINGS = (
    "RELAY_STORAGE",
    "RELAY_AUTH_STORE",
    "RELAY_DAEMON_STORE",
    "RELAY_CHAT_STORE",
)
_DATABASE_STORAGE_VALUES = frozenset({"postgres", "postgresql", "database", "db"})


def warn_retired_store_settings() -> None:
    for name in RETIRED_STORE_SETTINGS:
        if os.environ.get(name, "").strip():
            logger.warning(
                "{} is ignored: that state is always kept in the configured database.",
                name,
            )


def retired_settings_chose_database_accounts() -> bool:
    """Whether the retired switches still say accounts lived in the database.

    They chose the database account store, so any account files under the
    data directory are leftovers the backend never read and must not be
    imported over the real accounts.
    """
    storage = os.environ.get("RELAY_STORAGE", "").strip().lower()
    auth = os.environ.get("RELAY_AUTH_STORE", "").strip().lower()
    return storage in _DATABASE_STORAGE_VALUES or auth == "database"


def _aggregate_database_url(aggregate: str) -> tuple[str, bool]:
    url = database_url_from_env(setting=f"database-only {aggregate} storage")
    return url, url.startswith("sqlite")


def daemon_store_from_env() -> DaemonStore:
    url, create_schema = _aggregate_database_url("daemon")
    return DatabaseDaemonStore(url, create_schema=create_schema)


def agent_store_from_env() -> AgentStore:
    url, create_schema = _aggregate_database_url("agent")
    return DatabaseAgentStore(url, create_schema=create_schema)


def admin_token_store_from_env() -> DatabaseAdminTokenStore:
    # Database-only for the same reason as org settings, and so the token
    # survives a container that has no data volume.
    database_url = database_url_from_env(setting="database-only admin token storage")
    return DatabaseAdminTokenStore(
        database_url, create_schema=database_url.startswith("sqlite")
    )


def org_settings_store_from_env(root_dir: Path) -> DatabaseOrgSettingsStore:
    # Database-only, like sessions and tasks: a database engine always exists,
    # so a file-backed twin would only be a second code path to keep in sync.
    database_url = database_url_from_env(setting="database-only settings storage")
    return DatabaseOrgSettingsStore(
        database_url, create_schema=database_url.startswith("sqlite")
    )


def team_store_from_env() -> TeamStore:
    url, create_schema = _aggregate_database_url("team")
    return DatabaseTeamStore(url, create_schema=create_schema)


def project_store_from_env(root_dir: Path) -> DatabaseProjectStore:
    database_url = database_url_from_env(setting="database-only project storage")
    return DatabaseProjectStore(
        database_url, create_schema=database_url.startswith("sqlite")
    )


def skill_store_from_env(root_dir: Path, blob_store: BlobStore | None = None) -> DatabaseSkillStore:
    database_url = database_url_from_env(setting="database-only skill storage")
    local_objects = LocalSkillObjectStore(root_dir / "skills" / "objects")
    return DatabaseSkillStore(
        database_url,
        create_schema=database_url.startswith("sqlite"),
        # With a blob store the data dir is only a read fallback for objects
        # an earlier version wrote there, so the backend needs no volume.
        object_store=(
            BlobSkillObjectStore(blob_store, fallback=local_objects)
            if blob_store is not None
            else local_objects
        ),
    )


def agent_placement_store_from_env() -> AgentPlacementStore:
    url, create_schema = _aggregate_database_url("agent placement")
    return DatabaseAgentPlacementStore(url, create_schema=create_schema)


def session_store_from_env(root_dir: Path, blob_store: BlobStore | None = None) -> DatabaseSessionStore:
    database_url = database_url_from_env(setting="database-only thread storage")
    store = DatabaseSessionStore(
        database_url,
        create_schema=database_url.startswith("sqlite"),
        blob_store=blob_store,
    )
    store.verify_schema()
    return store


def task_store_from_env(root_dir: Path) -> DatabaseTaskStore:
    database_url = database_url_from_env(setting="database-only thread storage")
    store = DatabaseTaskStore(
        database_url,
        create_schema=database_url.startswith("sqlite"),
    )
    store.verify_schema()
    return store


def automation_store_from_env() -> DatabaseAutomationStore:
    url = database_url_from_env(setting="database-only automation storage")
    return DatabaseAutomationStore(url, create_schema=url.startswith("sqlite"))


def notification_store_from_env() -> DatabaseNotificationStore:
    url = database_url_from_env(setting="database-only notification storage")
    return DatabaseNotificationStore(url, create_schema=url.startswith("sqlite"))


def waitlist_service_from_env(mailer: Mailer) -> WaitlistService:
    # Database-only like org settings.
    url = database_url_from_env(setting="database-only waitlist storage")
    store = DatabaseWaitlistStore(url, create_schema=url.startswith("sqlite"))
    return WaitlistService(store, mailer, config=waitlist_config_from_env())


def chat_store_from_env() -> ChatStore:
    url, create_schema = _aggregate_database_url("chat")
    return DatabaseChatIntegrationStore(url, create_schema=create_schema)


@dataclass(frozen=True)
class Stores:
    """Every store the app serves from, built once per process."""

    blob: BlobStore | None
    sessions: DatabaseSessionStore
    tasks: DatabaseTaskStore
    automations: DatabaseAutomationStore
    daemon: DaemonStore
    chat: ChatStore
    auth: DatabaseAccountAuthStore
    managed_nodes: DatabaseManagedNodeStore
    agents: AgentStore
    teams: TeamStore
    projects: DatabaseProjectStore
    skills: DatabaseSkillStore
    placements: AgentPlacementStore
    profile_images: DatabaseProfileImageStore
    org_settings: DatabaseOrgSettingsStore
    notifications: DatabaseNotificationStore


def build_stores(root_dir: Path) -> Stores:
    # One client for every store that keeps bytes outside Postgres.
    warn_retired_store_settings()
    blob_store = blob_store_from_env()
    session_store = session_store_from_env(root_dir, blob_store)
    # After the session store, so a missing database is reported as missing
    # thread storage — the dependency an operator recognizes.
    configure_admin_token(root_dir, admin_token_store_from_env())
    database_url = session_store.engine.url.render_as_string(hide_password=False)
    create_schema = session_store.engine.dialect.name == "sqlite"
    auth_store = auth_store_from_env()
    return Stores(
        blob=blob_store,
        sessions=session_store,
        tasks=task_store_from_env(root_dir),
        automations=automation_store_from_env(),
        daemon=daemon_store_from_env(),
        chat=chat_store_from_env(),
        auth=auth_store,
        managed_nodes=DatabaseManagedNodeStore(database_url, create_schema=create_schema),
        agents=agent_store_from_env(),
        teams=team_store_from_env(),
        projects=project_store_from_env(root_dir),
        skills=skill_store_from_env(root_dir, blob_store),
        placements=agent_placement_store_from_env(),
        profile_images=DatabaseProfileImageStore(database_url, create_schema=create_schema),
        org_settings=org_settings_store_from_env(root_dir),
        notifications=notification_store_from_env(),
    )
