from __future__ import annotations

import pytest

from relay.core.models import AGENT_ROLES
from relay.core.role_charters import ROLE_CHARTERS, UNASSIGNED_CHARTER, role_charter


def test_every_role_has_its_own_charter() -> None:
    assert set(ROLE_CHARTERS) == set(AGENT_ROLES)
    assert len(set(ROLE_CHARTERS.values())) == len(AGENT_ROLES)


@pytest.mark.parametrize(
    ("role", "boundary"),
    [
        ("planner", "Do not implement"),
        ("implementer", "no speculative refactors"),
        ("reviewer", "Do not rewrite the work yourself"),
        ("tester", "leave product defects to the implementer or fixer"),
        ("fixer", "and only those"),
        ("researcher", "Do not design or implement"),
        ("designer", "Do not implement"),
        ("writer", "Do not change behaviour to fit the prose"),
        ("devops", "Do not redesign the product"),
    ],
)
def test_a_charter_names_what_the_role_leaves_to_others(role: str, boundary: str) -> None:
    assert boundary in role_charter(role)


def test_one_role_vocabulary_feeds_every_seam() -> None:
    from relay.collaboration import contracts, intake, styles

    assert set(AGENT_ROLES) == set(ROLE_CHARTERS)
    assert set(AGENT_ROLES) == set(contracts.ROLES)
    assert set(AGENT_ROLES) == set(intake.VALID_ROLES)
    assert set(AGENT_ROLES) == set(styles.ROLE_STAGE)


def test_pipeline_puts_review_last_and_an_unknown_role_with_the_implementers() -> None:
    from relay.collaboration.styles import ROLE_STAGE, role_stage

    assert ROLE_STAGE["reviewer"] == max(ROLE_STAGE.values())
    assert role_stage(None) == ROLE_STAGE["implementer"]
    assert role_stage("unknown") == ROLE_STAGE["implementer"]


def test_a_member_without_a_role_gets_the_neutral_brief() -> None:
    assert role_charter(None) == UNASSIGNED_CHARTER
    assert role_charter("unknown") == UNASSIGNED_CHARTER
