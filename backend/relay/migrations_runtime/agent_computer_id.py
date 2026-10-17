"""Turn auto-generated compatibility agents into declared plain agents, in place.

One-time, idempotent. Goes through the store's own update path so events and
snapshots stay in lockstep — do not switch this to raw Alembic SQL; agent
reads come from the snapshot column, and a direct rewrite would bypass the
write path entirely.
"""

from __future__ import annotations

from typing import Any

from loguru import logger

from ..core.computer_identity import computer_id, is_provisional_computer_id

DEFAULT_ROLE = "implementer"


def migrate_agent_placement_computer_ids(
    placement_store: Any, registry: Any
) -> int:
    """Persist stable Computer identities onto active legacy placements.

    Older placement snapshots predate ``computerId``. Leaving them keyed by
    daemon node id splits one Computer into multiple UI bands and prevents the
    placement from following that Computer through runtime reprovisioning.
    Rebinding through the store preserves the placement id and appends the
    repair through the event-sourced write path.
    """
    nodes = {node["id"]: node for node in registry.monitor_nodes()}
    migrated = 0
    for placement in placement_store.list_placements():
        if not _placement_needs_migration(placement):
            continue
        node = nodes.get(placement.get("daemonNodeId"))
        if not node:
            logger.warning(
                "Skipping placement computer-id migration: daemon node not found",
                placement_id=placement.get("id"),
                daemon_node_id=placement.get("daemonNodeId"),
            )
            continue
        target_computer_id = computer_id(node)
        if is_provisional_computer_id(target_computer_id):
            continue
        try:
            placement_store.rebind_placement(
                placement["id"],
                node["id"],
                managed_node_id=node.get("managedNodeId"),
                computer_id_value=target_computer_id,
            )
            migrated += 1
        except Exception as error:  # noqa: BLE001 - one bad legacy placement
            logger.warning(
                "Skipping placement computer-id migration after unexpected error",
                placement_id=placement.get("id"),
                error=str(error),
            )
    return migrated


def migrate_agent_computer_ids(
    agent_store: Any, placement_store: Any, registry: Any | None = None
) -> int:
    """Return how many agents this run migrated. Already-migrated ones don't count.

    registry is optional; it's the fallback for legacy placements created
    before spec ① (and so lacking a computerId) — it lets us derive an
    identity from the placement's daemonNodeId via the registry instead.
    """
    migrated = 0
    for agent in agent_store.list_agents():
        if not _agent_needs_migration(agent):
            continue
        try:
            agent_computer_id = _computer_id_from_placements(
                placement_store, agent["id"], registry
            )
            if not agent_computer_id:
                logger.warning(
                    "Skipping agent migration: no placement to read a computer id from",
                    agent_id=agent["id"],
                )
                continue
            agent_store.set_birth_certificate(
                agent["id"],
                computer_id=agent_computer_id,
                default_role=agent.get("defaultRole") or DEFAULT_ROLE,
            )
            migrated += 1
        except Exception as error:  # noqa: BLE001 - one bad record must not
            # abort the loop and wedge every agent after it, forever, on
            # every future restart. Log and move on to the next agent.
            logger.warning(
                "Skipping agent migration after unexpected error",
                agent_id=agent.get("id"),
                error=str(error),
            )
            continue
    return migrated


def pending_agent_computer_id_migrations(
    agent_store: Any, placement_store: Any
) -> dict[str, Any]:
    """What the startup migration would still touch, without writing.

    Uses the migration's own predicates, so an empty report means both
    functions above are no-ops on this data and can be deleted.
    """
    agents = [
        agent["id"]
        for agent in agent_store.list_agents()
        if _agent_needs_migration(agent)
    ]
    placements = [
        {
            "id": placement.get("id"),
            "agentId": placement.get("agentId"),
            "daemonNodeId": placement.get("daemonNodeId"),
        }
        for placement in placement_store.list_placements()
        if _placement_needs_migration(placement)
    ]
    return {
        "agents": agents,
        "placements": placements,
        "converged": not agents and not placements,
    }


def log_agent_computer_id_status(agent_store: Any, placement_store: Any) -> str:
    """Log, and return, one line saying whether the migration is still needed.

    ``deploy/deploy.sh agent-ids`` reads this line from the backend's
    deployment logs, since production's database is not reachable from
    outside Railway. Keep the wording in step with that command.
    """
    report = pending_agent_computer_id_migrations(agent_store, placement_store)
    if report["converged"]:
        line = "agent-computer-ids converged"
        logger.info(line)
    else:
        line = (
            f"agent-computer-ids pending agents={len(report['agents'])} "
            f"placements={len(report['placements'])}"
        )
        logger.warning(line)
    return line


def _agent_needs_migration(agent: dict[str, Any]) -> bool:
    if agent.get("deletedAt"):
        return False
    return bool(agent.get("compatibilityKey")) or is_provisional_computer_id(
        agent.get("computerId")
    )


def _placement_needs_migration(placement: dict[str, Any]) -> bool:
    current_computer_id = placement.get("computerId")
    return not current_computer_id or is_provisional_computer_id(current_computer_id)


def _computer_id_from_placements(
    placement_store: Any, agent_id: str, registry: Any | None
) -> str | None:
    """Read computerId off the agent's placements.

    Does not parse compatibilityKey: after spec ①, the middle segment of the
    key is a prefixed identity (e.g. alice:device:alice:machine-a:claude),
    and splitting on colons can't recover it unambiguously.

    Trusts active placements only: `list_placements` excludes removed
    records by default, and both stores sort by (priority, id), where id is
    a random uuid — an agent that ever changed computers will have one
    active placement and at least one removed (stale) one. Taking "the first
    sorted record with a computerId" without distinguishing active from
    removed would, about half the time, write a since-retired computer into
    the agent's immutable birth certificate.

    Only falls back to include_removed=True when there isn't a single active
    placement, and even then picks the newest by createdAt (never an
    arbitrary one) — to avoid the same sort-order randomness.

    spec ① only wrote computerId onto **newly created** placements, so most
    legacy placements in production lack the field — reading it alone would
    make this migration a near-total no-op on real data. So for placements
    missing it, derive an identity from the placement's daemonNodeId via the
    registry instead.
    """
    active_placements = placement_store.list_placements(agent_id=agent_id)
    computer_id_value = _first_computer_id(active_placements)
    if computer_id_value:
        return computer_id_value

    candidate_placements = active_placements
    if not candidate_placements:
        all_placements = placement_store.list_placements(
            agent_id=agent_id, include_removed=True
        )
        candidate_placements = sorted(
            all_placements,
            key=lambda item: item.get("createdAt") or "",
            reverse=True,
        )
        computer_id_value = _first_computer_id(candidate_placements)
        if computer_id_value:
            return computer_id_value

    if registry is None:
        return None
    nodes = {node["id"]: node for node in registry.monitor_nodes()}
    for placement in candidate_placements:
        node = nodes.get(placement.get("daemonNodeId"))
        if node:
            computer_id_value = computer_id(node)
            if not is_provisional_computer_id(computer_id_value):
                return computer_id_value
    return None


def _first_computer_id(placements: list[dict[str, Any]]) -> str | None:
    for placement in placements:
        computer_id_value = placement.get("computerId")
        if computer_id_value and not is_provisional_computer_id(computer_id_value):
            return computer_id_value
    return None
