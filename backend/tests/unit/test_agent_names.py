from __future__ import annotations

import random
from pathlib import Path

import pytest
from relay.core.agent_names import AGENT_NAME_POOL, generate_agent_name
from relay.persistence.agent_store import DatabaseAgentStore
from store_fixtures import make_agent_store


def _make_store(tmp_path: Path):
    return DatabaseAgentStore(f"sqlite:///{tmp_path}/agents.db", create_schema=True)


def test_agent_name_pool_has_no_case_insensitive_duplicates() -> None:
    folded = [name.casefold() for name in AGENT_NAME_POOL]
    assert len(folded) == len(set(folded))


def test_generated_name_comes_from_the_theme_pool() -> None:
    assert generate_agent_name(taken=lambda _: False) in AGENT_NAME_POOL


def test_generator_skips_taken_names() -> None:
    available = AGENT_NAME_POOL[7]

    name = generate_agent_name(taken=lambda candidate: candidate != available)

    assert name == available


def test_generator_falls_back_to_numeric_suffix_when_pool_is_exhausted() -> None:
    taken = {name.casefold() for name in AGENT_NAME_POOL}

    name = generate_agent_name(
        taken=lambda candidate: candidate.casefold() in taken,
        rng=random.Random(1),
    )

    base, separator, suffix = name.rpartition(" ")
    assert separator == " "
    assert base in AGENT_NAME_POOL
    assert suffix == "2"


def test_generator_increments_the_suffix_until_it_is_free() -> None:
    taken = {name.casefold() for name in AGENT_NAME_POOL}
    taken.update(f"{name} 2".casefold() for name in AGENT_NAME_POOL)

    name = generate_agent_name(
        taken=lambda candidate: candidate.casefold() in taken,
        rng=random.Random(1),
    )

    assert name.endswith(" 3")


def test_create_agent_generates_a_themed_name_when_display_name_is_missing(
    tmp_path: Path
) -> None:
    store = _make_store(tmp_path)

    agent = store.create_agent(
        "alice", {"executorKind": "claude", "defaultRole": "implementer"}
    )

    assert agent["displayName"] in AGENT_NAME_POOL
    assert store.events(agent["id"])[0]["agent"]["displayName"] == agent["displayName"]


def test_create_agent_generates_a_themed_name_when_display_name_is_blank(
    tmp_path: Path
) -> None:
    store = _make_store(tmp_path)

    agent = store.create_agent(
        "alice",
        {"displayName": "   ", "executorKind": "claude", "defaultRole": "implementer"},
    )

    assert agent["displayName"] in AGENT_NAME_POOL


def test_generated_names_are_unique_within_a_supervisor(
    tmp_path: Path
) -> None:
    store = _make_store(tmp_path)

    first = store.create_agent(
        "alice", {"executorKind": "claude", "defaultRole": "implementer"}
    )
    second = store.create_agent(
        "alice", {"executorKind": "codex", "defaultRole": "implementer"}
    )

    assert first["displayName"].casefold() != second["displayName"].casefold()


def test_generated_names_do_not_collide_with_existing_agents(
    tmp_path: Path
) -> None:
    store = _make_store(tmp_path)
    taken_names = set(AGENT_NAME_POOL)
    for _ in range(3):
        agent = store.create_agent(
            "alice", {"executorKind": "claude", "defaultRole": "implementer"}
        )
        taken_names.discard(agent["displayName"])

    assert len(taken_names) == len(AGENT_NAME_POOL) - 3


def test_create_agent_still_honors_an_explicit_display_name(tmp_path: Path) -> None:
    store = make_agent_store(tmp_path)

    agent = store.create_agent(
        "alice",
        {
            "displayName": "Researcher",
            "executorKind": "claude",
            "defaultRole": "implementer",
        },
    )

    assert agent["displayName"] == "Researcher"


def test_create_agent_rejects_a_non_string_display_name(tmp_path: Path) -> None:
    store = make_agent_store(tmp_path)

    with pytest.raises(ValueError, match="displayName must be a string"):
        store.create_agent("alice", {"displayName": 42, "executorKind": "claude"})
