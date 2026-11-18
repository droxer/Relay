"""Regression seams for the task execution review, using real continuity callers."""
import json
from concurrent.futures import Future

import pytest

from relay.sessions.bridge import compute_prior_agent_bridge
from relay.sessions.conversation import compute_conversation_history
from relay.sessions.handoff_context import capture_handoff_context
from relay.tasks import scheduler


class NoArtifacts:
    def read_artifact(self, *_):
        raise AssertionError("The completed run already contains its transcript")


def test_completed_dispatch_timeout_propagates_instead_of_spinning(monkeypatch):
    future = Future()
    failure = TimeoutError("dispatch operation timed out")
    future.set_exception(failure)
    # Bound the regression on the buggy implementation without leaking a worker.
    monkeypatch.setattr(scheduler.logger, "warning", lambda *a, **kw: pytest.fail(
        "A finished dispatch must not be treated as still waiting"
    ))
    with pytest.raises(TimeoutError) as caught:
        scheduler._await_dispatch(future, "task")
    assert caught.value is failure


@pytest.mark.parametrize("message", [
    {"type": "item.completed", "item": {"type": "agent_message", "text": "Verified migration"}},
    {"type": "message", "role": "assistant", "content": [{"type": "output_text", "text": "Verified migration"}]},
])
def test_raw_codex_reply_survives_bridge_history_and_handoff(message):
    log = "[Codex Exit 0]\nstdout:\n" + "\n".join(map(json.dumps, [
        {"type": "item.completed", "item": {"type": "agent_message", "text": "Earlier draft"}},
        message,
        {"type": "item.completed", "item": {"type": "command_execution", "text": "tool noise"}},
        {"type": "turn.completed"},
    ]))
    session = {
        "id": "session", "taskGoal": "Review migration", "createdAt": "2026-11-18T00:00:00Z",
        "events": [], "agentRuns": [{
            "id": "run", "agent": "codex", "status": "completed", "agentLog": log,
            "startedAt": "2026-11-18T00:01:00Z", "completedAt": "2026-11-18T00:02:00Z",
        }],
    }
    store = NoArtifacts()
    assert compute_prior_agent_bridge(session, "claude", store) == "[Previous from @codex]\nVerified migration"
    session["events"] = [{"type": "user.message", "text": "Continue", "timestamp": "2026-11-18T00:03:00Z"}]
    history = compute_conversation_history(session, store)
    assert "[Assistant @codex]\nVerified migration" in history
    context = capture_handoff_context(session, {"assignmentId": "next", "executorKind": "claude"}, None, store)
    assert "Verified migration" in context["priorContext"]
    assert context["missingRunIds"] == []
    assert "Earlier draft" not in context["priorContext"]


@pytest.mark.parametrize("event", [
    {"type": "item.started", "item": {"type": "agent_message", "text": "unfinished"}},
    {"type": "message", "role": "user", "content": "not an answer"},
    {"type": "item.completed", "item": None},
    {"type": ["invalid"]},
    {"type": "message", "content": [{"type": {"invalid": True}, "text": "not text"}]},
])
def test_unfinished_or_nonassistant_records_are_not_continuity_answers(event):
    session = {"id": "s", "agentRuns": [{"id": "r", "agent": "codex", "status": "completed",
        "agentLog": "stdout:\n" + json.dumps(event)}]}
    assert compute_prior_agent_bridge(session, "claude", NoArtifacts()).endswith("<no output>")
