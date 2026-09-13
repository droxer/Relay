from copy import deepcopy

from relay.sessions.handoff_context import capture_handoff_context


class NoArtifacts:
    def read_artifact(self, *_):
        raise FileNotFoundError


def test_context_uses_event_order_and_preserves_logical_identity_and_notes():
    session = {
        "id": "ses_1",
        "taskGoal": "original",
        "workspaceLayout": "thread",
        "events": [
            {
                "id": "e1",
                "type": "user.message",
                "text": "latest objective",
                "timestamp": "2030",
            },
            {
                "id": "e2",
                "type": "human.decision",
                "decision": {
                    "kind": "handoff",
                    "targetAgentId": "builder",
                    "note": "preserve compatibility",
                },
            },
            {"id": "e3", "type": "agent.completed", "runId": "r1", "timestamp": "2020"},
        ],
        "agentRuns": [
            {
                "id": "r1",
                "agent": "codex",
                "logicalAgentId": "builder",
                "status": "completed",
                "agentLog": "● implemented",
            }
        ],
    }
    result = capture_handoff_context(
        session,
        {"assignmentId": "a2", "agentId": "reviewer", "executorKind": "codex"},
        "verify",
        NoArtifacts(),
    )
    assert result["objective"] == "latest objective"
    assert result["sourceEventId"] == "e3"
    assert result["sourceEventCount"] == 3
    assert result["sourceRunId"] == "r1"
    assert "builder" in result["priorContext"]
    assert "preserve compatibility" in result["priorContext"]
    assert "implemented" in result["priorContext"]
    saved = deepcopy(result)
    session["agentRuns"][0]["agentLog"] = "● changed"
    assert result == saved


def test_context_is_bounded_and_retains_active_instruction_and_latest_result():
    session = {
        "id": "s",
        "taskGoal": "goal" * 10000,
        "events": [],
        "agentRuns": [
            {
                "id": "r",
                "agent": "codex",
                "status": "failed",
                "agentLog": "x" * 50000 + "LATEST",
            },
        ],
    }
    context = capture_handoff_context(
        session,
        {"assignmentId": "a", "agentId": "b", "executorKind": "codex"},
        "note" * 20000,
        NoArtifacts(),
    )
    assert sum(len(context[k]) for k in ("objective", "note", "priorContext")) <= 24000
    assert context["truncated"]
    assert "LATEST" in context["priorContext"]
    assert context["note"].startswith("note")
    assert context["runIds"] == ["r"]


def test_later_historical_notes_cannot_evict_the_latest_result():
    session = {
        "id": "s",
        "taskGoal": "goal",
        "events": [
            {"type": "agent.completed", "runId": "r"},
            {
                "type": "human.decision",
                "decision": {"kind": "handoff", "note": "history" * 10000},
            },
        ],
        "agentRuns": [
            {
                "id": "r",
                "agent": "codex",
                "logicalAgentId": "builder",
                "status": "completed",
                "agentLog": "● LATEST VERIFIED RESULT",
            }
        ],
    }
    context = capture_handoff_context(
        session,
        {"assignmentId": "a", "agentId": "reviewer", "executorKind": "codex"},
        "check",
        NoArtifacts(),
    )
    assert "LATEST VERIFIED RESULT" in context["priorContext"]
    assert "builder" in context["priorContext"]
    assert context["truncated"]
    assert sum(len(context[k]) for k in ("objective", "note", "priorContext")) <= 24000
