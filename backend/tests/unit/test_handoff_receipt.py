import hashlib
import json
from copy import deepcopy

import pytest

from relay.sessions.handoff_context import capture_handoff_context


class Snapshots:
    def __init__(self, content):
        self.content = content

    def read_artifact_content(self, session_id, artifact_id):
        return self.content.get(artifact_id)

    def read_artifact(self, *_):
        raise KeyError


def source():
    return {
        "id": "thread", "taskGoal": "Build the feature", "workspaceLayout": "thread",
        "events": [{"id": "e1", "type": "agent.completed", "runId": "run"}],
        "agentRuns": [{"id": "run", "assignmentId": "source", "agent": "codex",
                       "status": "completed", "agentLog": "● Partial implementation"}],
        "artifacts": [{"id": "checkpoint", "kind": "workspace_file", "agentRunId": "run",
                       "workspaceRelativePath": "PROGRESS.md.handoff.json"}],
    }


TARGET = {"assignmentId": "target", "agentId": "reviewer", "executorKind": "codex"}


def test_receipt_freezes_requirements_claims_and_snapshot_digest():
    session = source()
    checkpoint = {"assignmentId": "source", "completed": ["API implemented"],
                  "pending": ["Test failure handling"], "blockers": [],
                  "failedApproaches": ["Old parser rejected inputs"],
                  "verification": ["Unit tests passed"], "nextAction": "Add failure tests"}
    content = json.dumps(checkpoint).encode()
    task = {"id": "task", "title": "Build API", "description": "Acceptance: reject invalid input. " * 220,
            "events": [{"id": "task-revision"}]}
    context = capture_handoff_context(session, TARGET, "Preserve compatibility", Snapshots({"checkpoint": content}), task=task)
    receipt = context["receipt"]
    assert receipt["workDefinition"]["requirements"] == task["description"]
    assert receipt["source"]["taskEventId"] == "task-revision"
    assert receipt["checkpoint"]["claims"] == checkpoint
    assert receipt["checkpoint"]["sha256"] == hashlib.sha256(content).hexdigest()
    saved = deepcopy(context)
    task["description"] = "Changed later"
    session["artifacts"].clear()
    assert context == saved


@pytest.mark.parametrize("content,status", [
    (None, "snapshot_missing"),
    (b"not json", "invalid"),
    (b'{"assignmentId":"older"}', "stale"),
])
def test_receipt_never_treats_missing_or_stale_checkpoint_as_completed_work(content, status):
    receipt = capture_handoff_context(source(), TARGET, None, Snapshots({"checkpoint": content}))["receipt"]
    assert receipt["checkpoint"]["status"] == status
    assert "claims" not in receipt["checkpoint"]
    assert receipt["verificationRequired"] is True


def test_receipt_rejects_oversized_requirements_instead_of_truncating_them():
    with pytest.raises(ValueError, match="handoff_requirements_too_large"):
        capture_handoff_context(source(), TARGET, None, Snapshots({}), task={
            "id": "task", "title": "Build", "description": "a" * 17000,
        })


def test_receipt_does_not_reuse_a_previous_runs_checkpoint():
    session = source()
    session["artifacts"][0]["agentRunId"] = "older-run"
    receipt = capture_handoff_context(session, TARGET, None, Snapshots({}))["receipt"]
    assert receipt["checkpoint"]["status"] == "missing"
