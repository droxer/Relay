"""Suggested next steps: follow-up requests a finished run offers its person.

The run writes them to a private control file; the daemon reports them on
`run.completed` and the thread's `session.completed` carries them, so the web
offers each as a one-click reply. Agent-written, so bounded here with the
limits relay-core's `next-steps.ts` uses (`tests/unit/test_next_steps_parity.py`).
"""

from __future__ import annotations

from typing import Any

# Mirrors NEXT_STEPS_RELATIVE_PATH in relay-core; `.relay/` is excluded from
# the artifact scan, so the control file never becomes a deliverable.
NEXT_STEPS_RELATIVE_PATH = ".relay/next-steps.json"
NEXT_STEPS_MAX = 3
NEXT_STEP_MAX_CHARS = 160


def sanitize_next_steps(raw: Any) -> list[str]:
    """Trimmed, whitespace-collapsed, distinct, and bounded; anything else is dropped."""
    if not isinstance(raw, list):
        return []
    steps: list[str] = []
    for item in raw:
        if not isinstance(item, str):
            continue
        text = " ".join(item.split())[:NEXT_STEP_MAX_CHARS]
        if text and text not in steps:
            steps.append(text)
        if len(steps) == NEXT_STEPS_MAX:
            break
    return steps
