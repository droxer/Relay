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

from ..persistence.agent_placement_store import reconcile_single_active_placement
from ..persistence.file_store_import import (
    CLI_COMMAND,
    file_stores_imported,
    import_local_file_stores_before_serving,
    local_file_stores_present,
)
from ..services.team_membership import reconcile_team_memberships
from .agent_computer_id import migrate_agent_computer_ids, migrate_agent_placement_computer_ids


def import_file_stores_before_serving(
    root_dir: Path, database_url: str, *, repairs_enabled: bool
) -> None:
    """Move the retired daemon/agent/team/placement/chat files into the database.

    Runs before anything reads those aggregates. With startup repairs off this
    replica may not write at boot, so a pending import stops startup instead.
    """
    if repairs_enabled:
        import_local_file_stores_before_serving(root_dir, database_url)
        return
    if local_file_stores_present(root_dir) and not file_stores_imported(
        root_dir, database_url
    ):
        raise RuntimeError(
            f"File-backed stores under {root_dir} have not been imported into the "
            f"database. Run {CLI_COMMAND} (use --dry-run to preview), or start one "
            "replica with RELAY_STARTUP_REPAIRS enabled."
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
    except Exception:  # noqa: BLE001 - legacy ids only affect display; startup must not depend on them
        logger.exception("Agent computer-id migration deferred")
