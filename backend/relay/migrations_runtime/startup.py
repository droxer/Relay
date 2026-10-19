"""Data repairs the backend applies to existing records before it serves.

Each one is idempotent and a no-op once the data is clean, so running it on
every start is safe; ``RELAY_STARTUP_REPAIRS=0`` skips them on a replica that
should not write at boot. Schema changes belong in Alembic (``make
backend-migrate``); these only heal rows older runtimes left inconsistent.
"""

from __future__ import annotations

from typing import Any

from loguru import logger

from ..persistence.agent.placements import reconcile_single_active_placement
from ..teams.membership import reconcile_team_memberships
from .agent_computer_id import (
    log_agent_computer_id_status,
    migrate_agent_computer_ids,
    migrate_agent_placement_computer_ids,
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
