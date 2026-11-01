"""When an open thread was abandoned before any agent ran in it.

A session is born ``running`` (``session.created``) and stays so until a run
settles it. A thread an older flow opened and planned but never dispatched
therefore reads ``running`` forever, with nothing live behind it. This is the
one rule for recognising such a thread and the event that settles it.
"""

from __future__ import annotations

from datetime import timedelta
from typing import Any

from ..persistence.events import relay_event

# Long enough that nothing still being set up or queued is mistaken for
# abandoned; a dispatched thread leaves this state within seconds.
ABANDONED_AFTER = timedelta(days=7)
NEVER_DISPATCHED_REASON = "never_dispatched"


def is_never_dispatched(session: dict[str, Any]) -> bool:
    """Open, no agent ever started in it, and not already being deleted."""
    return (
        session.get("status") == "running"
        and not session.get("agentRuns")
        and not session.get("deletionRequestedAt")
    )


def never_dispatched_settle_event(session_id: str) -> dict[str, Any]:
    """Close the thread the way a cancel does, naming Relay's reason so the
    log never reads as a person's decision."""
    return relay_event(
        "session.status",
        session_id,
        {"status": "cancelled", "phase": "cancelled", "reason": NEVER_DISPATCHED_REASON},
    )
