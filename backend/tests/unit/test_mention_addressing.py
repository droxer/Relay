"""The backend's leading-mention parser must agree with the composer's.

`web/src/lib/mentions.ts` decides whether the browser sends a message at all.
Anything it lets through and this parser rejects is a 400 the user could not
have seen coming, so the two scanners share one grammar.
"""

from __future__ import annotations

from typing import Any

import pytest
from fastapi import HTTPException

from relay.api.threads.messages import _leading_mention_agent_ids

AGENTS: list[dict[str, Any]] = [
    {"id": "kimi", "displayName": "Kimi", "enabled": True},
    {"id": "support", "displayName": "Support Bot", "enabled": True},
]


@pytest.mark.parametrize(
    ("text", "expected"),
    [
        ("@Kimi do it", ("kimi",)),
        ("  @Kimi do it", ("kimi",)),
        ("\u00a0@Kimi do it", ("kimi",)),
        ("@Kimi @Support Bot do it", ("kimi", "support")),
        ("@Support Bot do it", ("support",)),
        # The composer treats these as prose, so the backend must too.
        ("@ hello everyone", ()),
        ("@", ()),
        ("\n@Kimi hi", ()),
        ("hi @Kimi", ()),
        ("email me at @ the office", ()),
    ],
)
def test_addressing_matches_the_composer_grammar(
    text: str, expected: tuple[str, ...]
) -> None:
    assert _leading_mention_agent_ids(text, AGENTS) == expected


@pytest.mark.parametrize("text", ["@nobody hi", "@Kimi, do it", "@here look"])
def test_an_unresolvable_leading_name_is_refused(text: str) -> None:
    """The composer blocks these locally; the backend must not fail open."""
    with pytest.raises(HTTPException) as error:
        _leading_mention_agent_ids(text, AGENTS)

    assert error.value.status_code == 400
    assert error.value.detail["code"] == "message_address_required"
