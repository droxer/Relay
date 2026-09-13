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
        "id": "thread",
        "taskGoal": "Build the feature",
        "workspaceLayout": "thread",
        "events": [{"id": "e1", "type": "agent.completed", "runId": "run"}],
        "agentRuns": [
            {
                "id": "run",
                "assignmentId": "source",
                "agent": "codex",
                "status": "completed",
                "agentLog": "● Partial implementation",
            }
        ],
        "artifacts": [
            {
                "id": "checkpoint",
                "kind": "workspace_file",
                "agentRunId": "run",
                "workspaceRelativePath": "PROGRESS.md.handoff.json",
            }
        ],
    }


TARGET = {"assignmentId": "target", "agentId": "reviewer", "executorKind": "codex"}


def test_receipt_freezes_requirements_claims_and_snapshot_digest():
    session = source()
    checkpoint = {
        "assignmentId": "source",
        "completed": ["API implemented"],
        "pending": ["Test failure handling"],
        "blockers": [],
        "failedApproaches": ["Old parser rejected inputs"],
        "verification": ["Unit tests passed"],
        "nextAction": "Add failure tests",
    }
    content = json.dumps(checkpoint).encode()
    task = {
        "id": "task",
        "title": "Build API",
        "description": "Acceptance: reject invalid input. " * 220,
        "events": [{"id": "task-revision"}],
    }
    context = capture_handoff_context(
        session,
        TARGET,
        "Preserve compatibility",
        Snapshots({"checkpoint": content}),
        task=task,
    )
    receipt = context["receipt"]
    assert context["contract"] == {"name": "relay.handoff.context", "version": 3}
    assert receipt["workDefinition"]["requirements"] == task["description"]
    assert receipt["source"]["taskEventId"] == "task-revision"
    assert receipt["checkpoint"]["claims"] == checkpoint
    assert receipt["checkpoint"]["sha256"] == hashlib.sha256(content).hexdigest()
    saved = deepcopy(context)
    task["description"] = "Changed later"
    session["artifacts"].clear()
    assert context == saved


@pytest.mark.parametrize(
    "content,status",
    [
        (None, "snapshot_missing"),
        (b"not json", "invalid"),
        (b"[" * 2000 + b"]" * 2000, "invalid"),
        (b"x" * 8193, "invalid"),
        (b"[]", "invalid"),
        (b'{"assignmentId":"source","pending":"wrong type"}', "invalid"),
        (b'{"assignmentId":"source","nextAction":false}', "invalid"),
        (b'{"assignmentId":"older"}', "stale"),
    ],
)
def test_receipt_never_treats_missing_or_stale_checkpoint_as_completed_work(
    content, status
):
    receipt = capture_handoff_context(
        source(), TARGET, None, Snapshots({"checkpoint": content})
    )["receipt"]
    assert receipt["checkpoint"]["status"] == status
    assert "claims" not in receipt["checkpoint"]
    assert receipt["verificationRequired"] is True


def test_receipt_rejects_oversized_requirements_instead_of_truncating_them():
    with pytest.raises(ValueError, match="handoff_requirements_too_large"):
        capture_handoff_context(
            source(),
            TARGET,
            None,
            Snapshots({}),
            task={
                "id": "task",
                "title": "Build",
                "description": "a" * 17000,
            },
        )


def test_receipt_does_not_reuse_a_previous_runs_checkpoint():
    session = source()
    session["artifacts"][0]["agentRunId"] = "older-run"
    receipt = capture_handoff_context(session, TARGET, None, Snapshots({}))["receipt"]
    assert receipt["checkpoint"]["status"] == "missing"


def test_receipt_preserves_initial_constraints_and_full_current_request():
    session = source()
    session["taskGoal"] = "Build the feature without changing the public API"
    request = "Investigate this case " * 350
    session["events"].append({"id": "e2", "type": "user.message", "text": request})
    receipt = capture_handoff_context(session, TARGET, None, Snapshots({}))["receipt"]
    assert receipt["workDefinition"]["objective"] == session["taskGoal"]
    assert receipt["workDefinition"]["currentRequest"] == request


def test_receipt_renderer_rejects_unknown_versions_and_marks_claims_untrusted():
    from relay.sessions.handoff_receipt import render_handoff_receipt

    with pytest.raises(ValueError, match="Unsupported"):
        render_handoff_receipt(
            {"contract": {"name": "relay.handoff.receipt", "version": 2}}
        )
    receipt = capture_handoff_context(source(), TARGET, None, Snapshots({}))["receipt"]
    assert "untrusted evidence" in render_handoff_receipt(receipt)


def test_receipt_marks_partial_evidence_and_prioritizes_checkpoint():
    session = source()
    session["artifacts"].extend(
        {
            "id": f"file-{i}",
            "kind": "workspace_file",
            "agentRunId": "run",
            "workspaceRelativePath": f"file-{i}.txt",
        }
        for i in range(30)
    )
    receipt = capture_handoff_context(
        session,
        TARGET,
        None,
        Snapshots(
            {
                "checkpoint": b'{"assignmentId":"source","pending":["Finish work"]}',
            }
        ),
    )["receipt"]
    assert receipt["checkpoint"]["status"] == "recorded"
    assert len(receipt["workspace"]["artifacts"]) == 24
    assert receipt["workspace"]["referencesOmitted"] is True
    assert receipt["workspace"]["coverage"] == "partial"
