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
    ],
)
def test_a_charter_names_what_the_role_leaves_to_others(role: str, boundary: str) -> None:
    assert boundary in role_charter(role)


def test_a_member_without_a_role_gets_the_neutral_brief() -> None:
    assert role_charter(None) == UNASSIGNED_CHARTER
    assert role_charter("unknown") == UNASSIGNED_CHARTER
