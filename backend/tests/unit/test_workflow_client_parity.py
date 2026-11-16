"""Pin the workflow event fixture the web reducer is tested against.

`web/tests/workflowRuns.test.ts` replays the same events through the client
projection (`web/src/lib/workflowRuns.ts`) and must reach these snapshots,
either by projecting an event itself or — for a step result or retry, which
only the backend can judge — by taking the snapshot the backend serves.
Regenerate with `RELAY_UPDATE_FIXTURES=1` after an intentional reducer change.
"""
from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any

from relay.persistence.session.reducer import (
    SESSION_EVENT_HANDLERS, apply_session_event, materialize_events,
)
from test_workflow_compilation import compile_run

FIXTURE = Path(__file__).resolve().parents[3] / "web" / "tests" / "fixtures" / "workflow-events.json"
SESSION = "ses-workflow"


def _event(index: int, event_type: str, payload: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": f"evt-{index:02d}", "type": event_type, "sessionId": SESSION,
        "timestamp": f"2026-11-16T00:00:{index:02d}.000Z", **payload,
    }


def _binding(session: dict[str, Any]) -> dict[str, Any]:
    run = session["workflowRuns"][-1]
    current = run["assignments"][run["currentIndex"]]
    return {
        "workflowRunId": run["workflowRunId"], "workflowStepId": current["workflowStepId"],
        "workflowAttempt": current["workflowAttempt"], "assignmentId": current["assignmentId"],
        "expectedRevision": run["revision"],
    }


def _finished(session: dict[str, Any], run_id: str, outputs: dict[str, str]) -> dict[str, Any]:
    return {**_binding(session), "terminalEvent": {
        "type": "run.completed", "runId": run_id, "commandId": f"cmd-{run_id}", "exitCode": 0,
        "roundResult": {"runId": run_id, "status": "done", "work": {
            "status": "done", "evidence": ["checked"], "note": "", "outputs": outputs,
        }},
    }}


def _scenario(progress: bool) -> dict[str, Any]:
    created = _event(0, "session.created", {
        "workspacePath": "/workspace", "taskGoal": "Ship", "participants": ["human"],
        "ownerUserId": "owner", "projectId": "project-1", "teamId": "team-1",
        "computerId": "computer-1",
    })
    session = materialize_events([created])
    base = json.loads(json.dumps(session))
    steps: list[dict[str, Any]] = []

    def push(event_type: str, payload: dict[str, Any]) -> None:
        event = _event(len(steps) + 1, event_type, payload)
        apply_session_event(session, event)
        steps.append({"event": event, "expected": {
            "workflowRuns": json.loads(json.dumps(session.get("workflowRuns"))),
            "activeWorkflowRunId": session.get("activeWorkflowRunId"),
            "status": session["status"],
        }})

    push("workflow.started", {"assignments": compile_run()})
    if not progress:
        push("workflow.gate_decided", {**_binding(session), "actorUserId": "owner", "kind": "reject"})
        push("session.status", {"status": "cancelled", "phase": "cancelled"})
        return {"base": base, "steps": steps}
    first = session["workflowRuns"][-1]["assignments"][0]
    push("workflow.gate_decided", {**_binding(session), "actorUserId": "owner", "kind": "approve"})
    push("agent.started", {"runId": "run-a", "agent": "claude", "assignmentId": first["assignmentId"]})
    push("agent.completed", {"runId": "run-a", "status": "completed", "exitCode": 0})
    push("workflow.step_finished", _finished(session, "run-a", {"review notes": "Risks listed"}))
    push("workflow.admission_blocked", {**_binding(session), "reason": "workflow_placement_invalid"})
    push("workflow.recovery_decided", {**_binding(session), "actorUserId": "owner", "kind": "retry"})
    push("workflow.interrupted", {**_binding(session), "actorUserId": "owner"})
    push("workflow.recovery_decided", {**_binding(session), "actorUserId": "owner", "kind": "cancel"})
    return {"base": base, "steps": steps}


def _fixture() -> dict[str, Any]:
    return {"progression": _scenario(True), "rejection": _scenario(False)}


def test_web_workflow_fixture_matches_backend_reducer():
    actual = _fixture()
    if os.environ.get("RELAY_UPDATE_FIXTURES") == "1":
        FIXTURE.parent.mkdir(parents=True, exist_ok=True)
        FIXTURE.write_text(json.dumps(actual, sort_keys=True, separators=(",", ":")) + "\n", encoding="utf-8")
    assert json.loads(FIXTURE.read_text(encoding="utf-8")) == actual


def test_fixture_covers_every_workflow_event_type():
    covered = {
        step["event"]["type"] for scenario in _fixture().values() for step in scenario["steps"]
    }
    assert {name for name in SESSION_EVENT_HANDLERS if name.startswith("workflow.")} <= covered
