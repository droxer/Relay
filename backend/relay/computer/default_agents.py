"""One default agent per runtime a Computer brings, offered to its user.

When a Computer connects with a ready runtime it has never had an agent for,
its user is asked whether to create a default agent for it — an ordinary
declared agent named after the runtime, renamed, re-roled, or deleted like any
other. Nothing is created without that answer, except the one-time seed for
Computers enrolled before the offer existed (`ensure_default_agents`, run by
`migrations_runtime.default_agents`).

A (Computer, runtime) pair is offered until it is answered. An agent of that
runtime on that Computer that exists — or ever existed: deleted agents keep
their soft-deleted row — answers it, and so does a decline, kept in the
Account's onboarding choices (`security/onboarding.py`).
"""

from __future__ import annotations

from collections.abc import Iterable, Mapping, Sequence
from typing import Any

from ..agents.creation import AgentCreationError, create_agent_for_user
from ..core.computer_identity import computer_id, is_provisional_computer_id
from ..core.models import AGENT_NAMES
from ..core.node_readiness import is_live_node, ready_runtimes
from .names import computer_display_name

DEFAULT_AGENT_ROLE = "implementer"


def default_agent_offers(ctx: Any, user_id: str, declined: set[tuple[str, str]]) -> list[dict[str, Any]]:
    """The runtimes on this user's connected Computers still awaiting an answer.

    One entry per Computer with a live node, in the order the registry ranks
    them: ``{computerId, computerName, executorKinds}``.
    """
    history = ctx.agent_store.list_agents(supervisor_user_id=user_id, include_deleted=True)
    computers: dict[str, list[dict[str, Any]]] = {}
    for node in ctx.registry.monitor_nodes():
        if node.get("userId") != user_id or node.get("retiredAt"):
            continue
        key = computer_id(node)
        if not is_provisional_computer_id(key):
            computers.setdefault(key, []).append(node)
    offers = []
    for key, nodes in computers.items():
        if not any(is_live_node(node) for node in nodes):
            continue
        kinds = _unanswered_runtimes(key, nodes, history, declined)
        if kinds:
            offers.append(
                {
                    "computerId": key,
                    "computerName": computer_display_name(ctx, nodes[0]),
                    "executorKinds": kinds,
                }
            )
    return offers


def accept_default_agents(
    ctx: Any,
    user_id: str,
    target_computer_id: str,
    executor_kinds: Iterable[str],
    declined: set[tuple[str, str]] | None = None,
) -> list[dict[str, Any]]:
    """Create the default agents a person accepted; returns the new agents.

    Goes through `create_agent_for_user`, so the Computer must be the user's
    and each runtime ready on it. A runtime already answered — a second click,
    another tab — is skipped rather than given a second default.
    """
    requested = set(executor_kinds)
    unknown = requested - set(AGENT_NAMES)
    if unknown:
        raise AgentCreationError(
            "runtime_unavailable",
            f"Unknown runtime(s): {', '.join(sorted(unknown))}.",
        )
    history = ctx.agent_store.list_agents(supervisor_user_id=user_id, include_deleted=True)
    answered = _seeded_runtimes(target_computer_id, history)
    answered.update(kind for computer, kind in (declined or set()) if computer == target_computer_id)
    taken = _live_names(history)
    created = []
    for executor_kind in AGENT_NAMES:
        if executor_kind not in requested or executor_kind in answered:
            continue
        name = default_agent_name(executor_kind, taken)
        agent = create_agent_for_user(
            ctx,
            user_id,
            {
                "computerId": target_computer_id,
                "executorKind": executor_kind,
                "defaultRole": DEFAULT_AGENT_ROLE,
                "displayName": name,
            },
        )
        taken.add(name.casefold())
        created.append(agent)
    return created


def ensure_default_agents(
    ctx: Any,
    node: dict[str, Any],
    owned: list[dict[str, Any]],
    declined: set[tuple[str, str]] | None = None,
) -> list[dict[str, Any]]:
    """Create, unasked, the missing default agents for ``node``'s Computer.

    Only the one-time seed of pre-existing Computers calls this. ``owned`` is
    the user's agents including deleted ones. Returns the agents it created;
    the caller places them.
    """
    user_id = node.get("userId")
    node_computer_id = computer_id(node)
    if not user_id or is_provisional_computer_id(node_computer_id):
        return []
    missing = _unanswered_runtimes(node_computer_id, [node], owned, declined or set())
    taken = _live_names(owned)
    created: list[dict[str, Any]] = []
    for executor_kind in missing:
        name = default_agent_name(executor_kind, taken)
        agent = ctx.agent_store.create_agent(
            user_id,
            {
                "displayName": name,
                "executorKind": executor_kind,
                "defaultRole": DEFAULT_AGENT_ROLE,
                "computerId": node_computer_id,
            },
        )
        taken.add(name.casefold())
        created.append(agent)
    return created


def default_agent_name(executor_kind: str, taken: set[str]) -> str:
    """The runtime's name, numbered past any live agent already using it."""
    base = executor_kind.capitalize()
    if base.casefold() not in taken:
        return base
    suffix = 2
    while f"{base} {suffix}".casefold() in taken:
        suffix += 1
    return f"{base} {suffix}"


def _unanswered_runtimes(
    target_computer_id: str,
    nodes: list[dict[str, Any]],
    history: list[dict[str, Any]],
    declined: set[tuple[str, str]],
) -> list[str]:
    answered = _seeded_runtimes(target_computer_id, history)
    available = ready_runtimes(nodes)
    return [
        kind
        for kind in AGENT_NAMES
        if kind in available and kind not in answered and (target_computer_id, kind) not in declined
    ]


def _seeded_runtimes(target_computer_id: str, history: Sequence[Mapping[str, Any]]) -> set[str]:
    return {str(agent.get("executorKind")) for agent in history if agent.get("computerId") == target_computer_id}


def _live_names(history: Sequence[Mapping[str, Any]]) -> set[str]:
    return {str(agent.get("displayName", "")).casefold() for agent in history if not agent.get("deletedAt")}
