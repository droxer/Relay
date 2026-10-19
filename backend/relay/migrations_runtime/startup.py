"""Data repairs the backend applies to existing records before it serves.

Each one is idempotent and a no-op once the data is clean, so running it on
every start is safe; ``RELAY_STARTUP_REPAIRS=0`` skips them on a replica that
should not write at boot. Schema changes belong in Alembic (``make
backend-migrate``); these only heal rows older runtimes left inconsistent.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

from loguru import logger

from ..persistence.agent.placements import reconcile_single_active_placement
from ..persistence.legacy.file_stores import (
    CLI_COMMAND,
    file_stores_imported,
    import_local_file_stores_before_serving,
    local_file_stores_present,
)
from ..security.auth_file_import import (
    accounts_imported,
    legacy_accounts_present,
    migrate_legacy_accounts,
)
from ..teams.membership import reconcile_team_memberships
from .agent_computer_id import (
    log_agent_computer_id_status,
    migrate_agent_computer_ids,
    migrate_agent_placement_computer_ids,
)


def import_file_stores_before_serving(
    root_dir: Path,
    database_url: str,
    *,
    repairs_enabled: bool,
    accounts_already_in_database: bool = False,
) -> None:
    """Move the retired file stores into the database.

    Accounts go first, so the daemon/agent/team/placement rows imported next
    find the users they reference. Runs before anything reads those
    aggregates. With startup repairs off this replica may not write at boot,
    so a pending import stops startup instead.
    """
    if repairs_enabled:
        _import_accounts_before_serving(root_dir, database_url, accounts_already_in_database)
        import_local_file_stores_before_serving(root_dir, database_url)
        return
    pending = (
        legacy_accounts_present(root_dir) and not accounts_imported(root_dir, database_url)
    ) or (
        local_file_stores_present(root_dir) and not file_stores_imported(root_dir, database_url)
    )
    if pending:
        raise RuntimeError(
            f"File-backed stores under {root_dir} have not been imported into the "
            f"database. Run {CLI_COMMAND} (use --dry-run to preview), or start one "
            "replica with RELAY_STARTUP_REPAIRS enabled."
        )


def _import_accounts_before_serving(
    root_dir: Path, database_url: str, accounts_already_in_database: bool
) -> None:
    """Boot-time account import: a no-op without legacy files or once imported."""
    if not legacy_accounts_present(root_dir) or accounts_imported(root_dir, database_url):
        return
    try:
        report = migrate_legacy_accounts(
            root_dir,
            database_url,
            accounts_already_in_database=accounts_already_in_database,
        )
    except ValueError as error:
        raise RuntimeError(
            f"Importing the file-backed accounts under {root_dir / 'auth'} failed: "
            f"{error} Resolve the conflict -- or, if those files are leftovers "
            "from before the database held the accounts, move them aside -- then "
            f"rerun {CLI_COMMAND} (use --dry-run to preview) against the "
            "configured database."
        ) from error
    if report["accountsAlreadyInDatabase"]:
        logger.info(
            "Ignored file-backed accounts: the database already held the accounts",
            root_dir=str(root_dir),
        )
        return
    logger.info(
        "Imported file-backed accounts into the database",
        root_dir=str(root_dir),
        accounts=report["accounts"],
        users=report["users"],
        departments=report["departments"],
        skipped=report["skipped"],
    )


def repair_records_before_serving(
    *, team_store: Any, agent_store: Any, agent_placement_store: Any
) -> None:
    """Repairs the request paths depend on; a failure stops startup."""
    # Older runtimes could retire an agent without updating Teams. Repair those
    # dangling member references through Team events before serving requests.
    reconcile_team_memberships(team_store, agent_store)
    # Heal any agent left with multiple active placements before the
    # one-agent-one-computer invariant (idempotent; a no-op once collapsed).
    reconcile_single_active_placement(agent_placement_store)


def migrate_legacy_computer_ids(
    *, agent_store: Any, agent_placement_store: Any, registry: Any
) -> None:
    """Rewrite pre-machine-id computer ids; deferred, never fatal, on failure."""
    try:
        migrated_placements = migrate_agent_placement_computer_ids(agent_placement_store, registry)
        if migrated_placements:
            logger.info("Migrated legacy agent placement computer ids", count=migrated_placements)
        migrated = migrate_agent_computer_ids(agent_store, agent_placement_store, registry)
        if migrated:
            logger.info("Migrated compatibility agents", count=migrated)
        log_agent_computer_id_status(agent_store, agent_placement_store)
    except Exception:  # noqa: BLE001 - legacy ids only affect display; startup must not depend on them
        logger.exception("Agent computer-id migration deferred")
