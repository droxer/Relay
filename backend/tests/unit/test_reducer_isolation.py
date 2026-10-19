"""Applying an event never mutates the snapshot the caller passed in.

Stores reduce onto a shallow copy of the stored snapshot, so a reducer that
appended to a nested list would also change the caller's original record.
"""

from __future__ import annotations

import copy

from relay.persistence.session.rows import compact_session_snapshot
from relay.persistence.task.reducer import TASK_EVENT_HANDLERS
from relay.persistence.session.reducer import apply_session_event

TS = "2026-10-18T00:00:00.000Z"


def _session() -> dict:
    return {
        "id": "s1", "status": "running", "agentRuns": [{"id": "run_1", "agent": "codex"}],
        "artifacts": [], "decisions": [], "participantAgentIds": ["a1"], "collaborationRounds": [],
    }


def test_session_reducers_leave_the_source_snapshot_untouched() -> None:
    original = _session()
    before = copy.deepcopy(original)
    events = [
        {"type": "agent.started", "timestamp": TS, "runId": "run_2", "agent": "codex"},
        {"type": "agent.completed", "timestamp": TS, "runId": "run_1", "status": "completed", "exitCode": 0},
        {"type": "artifact.created", "timestamp": TS, "artifact": {"id": "art_1", "agentRunId": "run_1"}},
        {"type": "human.decision", "timestamp": TS, "decision": {"kind": "approve"}},
        {"type": "thread.participants_joined", "timestamp": TS, "agentIds": ["a2"]},
        {"type": "collaboration.round.started", "timestamp": TS, "manifest": {"roundId": "r1"}},
    ]
    for event in events:
        apply_session_event(compact_session_snapshot(original), event, retain_event=False)
    assert original == before


def test_task_reducers_leave_the_source_snapshot_untouched() -> None:
    original = {"id": "t1", "occurrenceIds": [], "linkedSessionIds": [], "activity": []}
    before = copy.deepcopy(original)
    for event in (
        {"type": "task.occurrence_created", "timestamp": TS, "occurrenceId": "o1"},
        {"type": "task.session_linked", "timestamp": TS, "sessionId": "s1"},
        {"type": "task.activity", "timestamp": TS, "activity": {"kind": "note"}},
    ):
        TASK_EVENT_HANDLERS[event["type"]](dict(original), event)
    assert original == before
