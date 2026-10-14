"""The round verdict contract is written three times — daemon, backend, web.

Each side bounds the untrusted verdict file itself, so their limits and the
blocked-round preamble must agree; this pins them so one cannot drift alone.
"""

from __future__ import annotations

import re
from pathlib import Path

from relay.collaboration.policy import (
    BLOCKED_ROUND_PREAMBLE,
    ROUND_RESULT_NOTE_MAX_CHARS,
    ROUND_RESULT_OPTION_MAX_CHARS,
    ROUND_RESULT_OPTIONS_MAX,
    ROUND_RESULT_REJECTIONS,
)

REPO = Path(__file__).parents[3]
DAEMON = (REPO / "packages/relay-daemon/src/round-result.ts").read_text()
PROTOCOL = (REPO / "packages/relay-core/src/daemon-node-protocol.ts").read_text()
WEB = (REPO / "web/src/lib/awaitingInput.ts").read_text()


def _ts_number(source: str, name: str) -> int:
    match = re.search(rf"const {name} = (\d+);", source)
    assert match, f"{name} not found"
    return int(match.group(1))


def test_daemon_bounds_match_the_backend() -> None:
    assert _ts_number(DAEMON, "NOTE_MAX_CHARS") == ROUND_RESULT_NOTE_MAX_CHARS
    assert _ts_number(DAEMON, "OPTIONS_MAX") == ROUND_RESULT_OPTIONS_MAX
    assert _ts_number(DAEMON, "OPTION_MAX_CHARS") == ROUND_RESULT_OPTION_MAX_CHARS


def test_web_bounds_and_preamble_match_the_backend() -> None:
    assert _ts_number(WEB, "OPTIONS_MAX") == ROUND_RESULT_OPTIONS_MAX
    assert _ts_number(WEB, "OPTION_MAX_CHARS") == ROUND_RESULT_OPTION_MAX_CHARS
    assert f'const BLOCKED_ROUND_PREAMBLE = "{BLOCKED_ROUND_PREAMBLE}";' in WEB


def test_every_daemon_rejection_reason_has_a_backend_explanation() -> None:
    match = re.search(r"DaemonRoundResultRejectionReason\s*=([^;]+);", PROTOCOL)
    assert match, "DaemonRoundResultRejectionReason not found"
    reasons = set(re.findall(r'"([a-z_]+)"', match.group(1)))
    assert reasons == set(ROUND_RESULT_REJECTIONS)
