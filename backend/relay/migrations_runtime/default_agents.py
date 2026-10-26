"""Seed default agents for Computers enrolled before the offer existed.

A connecting Computer asks its user whether to create a default agent per
ready runtime (``computer.default_agents``). Computers enrolled before that
question existed were never asked, so this gives them their defaults once:
it walks the runtimes every known Computer last reported ready and seeds them
through the agent store's own write path. A (Computer, runtime) pair that has,
or ever had, an agent is skipped, so a deleted agent is never revived.

It runs once per installation (``persistence.run_once``), not on every boot:
a Computer that connects afterwards is asked, and a restart must not answer
for a person who has not yet.
"""

from __future__ import annotations

from types import SimpleNamespace
from typing import Any

from loguru import logger

from ..computer.default_agents import ensure_default_agents
from ..persistence.agent.placements import create_node_placement
from ..persistence.db_time import parse_db_time, require_db_time
from ..persistence.run_once import initialize_run_once, run_once
from ..security.onboarding import declined_default_agents

SEED_JOB = "default_agent_seed"


def seed_default_agents(
    *,
    agent_store: Any,
    agent_placement_store: Any,
    registry: Any,
    auth_store: Any | None = None,
    cutoff: str | None = None,
) -> int:
    """Create and place missing default agents; returns how many it created.

    ``monitor_nodes`` lists the best node of a Computer first, so a runtime is
    placed on the most current node that reports it ready; later records of the
    same Computer see the new agent in the history and skip it.
    """
    live_users = {user["id"] for user in auth_store.list_users()} if auth_store else None
    ctx = SimpleNamespace(agent_store=agent_store)
    declines: dict[str, set[tuple[str, str]]] = {}
    if auth_store:
        for account in auth_store.list_accounts():
            user_id = account.get("userId")
            if user_id:
                declines.setdefault(user_id, set()).update(declined_default_agents(account.get("onboarding")))
    histories: dict[str, list[dict[str, Any]]] = {}
    created_count = 0
    for node in registry.monitor_nodes():
        if cutoff is not None:
            created_at = parse_db_time(node.get("createdAt"))
            if created_at is None or created_at > require_db_time(cutoff):
                continue
        user_id = node.get("userId")
        if not user_id or node.get("retiredAt"):
            continue
        if live_users is not None and user_id not in live_users:
            continue
        history = histories.get(user_id)
        if history is None:
            history = agent_store.list_agents(supervisor_user_id=user_id, include_deleted=True)
        created = ensure_default_agents(ctx, node, history, declines.get(user_id, set()))
        for agent in created:
            create_node_placement(agent_placement_store, agent, node)
        histories[user_id] = [*history, *created]
        created_count += len(created)
    return created_count


def seed_default_agents_at_startup(*, engine: Any, **stores: Any) -> None:
    """Retry the original cohort atomically until the seed completes.

    Persisting the cutoff is required before serving. Later failures roll back
    the work and leave the cutoff intact; new Computers are always asked.
    """
    initialize_run_once(engine, SEED_JOB)
    try:
        with run_once(engine, SEED_JOB) as cutoff:
            if cutoff is None:
                return
            created = seed_default_agents(**stores, cutoff=cutoff)
        logger.info("Seeded default agents for existing computers", count=created)
    except Exception:  # noqa: BLE001 - a missing default agent never blocks serving; the next boot retries
        logger.exception("Default agent seeding deferred")
