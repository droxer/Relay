"""Pure reducers for the internal workflow snapshot and gate event ledger.

The owner-session staging API freezes a run through the registry.
These reducers project gate, result and recovery events; none enqueue commands or
release execution reservations. The execution adapter must perform live
Project/Placement checks before delivery. The owner id here is an audit
invariant, never an authentication mechanism.

SessionEventRows applies these reducers while holding the database row lock.
Raising on a stale revision rolls back both the event and its projection, so two
replicas cannot both decide the same gate. Replaying the accepted event log uses
the same checks; no process-local approval state is needed.
"""
from __future__ import annotations

from ..core.workflows import snapshot_team_id

from copy import deepcopy
from typing import Any

from .workflow_compilation import workflow_work_graph, retry_workflow_assignment
from .workflow_results import workflow_step_result


def active_workflow_run(session: dict[str, Any]) -> dict[str, Any] | None:
    """The thread's current workflow run.

    A thread can hold several runs — a Task's workflow started again continues
    in its own thread — but only the newest is ever live: a run starts only
    once every earlier one has settled.
    """
    runs = session.get("workflowRuns") or []
    active_id = session.get("activeWorkflowRunId")
    return next(
        (run for run in reversed(runs) if run.get("workflowRunId") == active_id),
        runs[-1] if runs else None,
    )


def current_workflow_run(session: dict[str, Any]) -> dict[str, Any]:
    """The active run of a thread that must hold one."""
    run = active_workflow_run(session)
    if run is None:
        raise ValueError("workflow_run_missing")
    return run


def _assert_session_open(session: dict[str, Any], event: dict[str, Any]) -> None:
    if event.get("sessionId") != session["id"]:
        raise ValueError("workflow_session_mismatch")
    if session.get("deletionRequestedAt") or session.get("status") in (
        "completed", "failed", "cancelled",
    ):
        raise ValueError("workflow_session_closed")


def apply_workflow_started(session: dict[str, Any], event: dict[str, Any]) -> None:
    """Freeze a validated full sequence; a first-step gate starts closed."""
    _assert_session_open(session, event)
    assignments = event.get("assignments")
    if not isinstance(assignments, list) or not assignments or not all(
        isinstance(item, dict) for item in assignments
    ):
        raise ValueError("workflow_assignments_required")
    snapshot = assignments[0].get("teamSnapshot")
    if not isinstance(snapshot, dict):
        raise ValueError("workflow_snapshot_required")
    for session_key, team_key in (
        ("teamId", "id"), ("projectId", "projectId"),
        ("ownerUserId", "ownerUserId"), ("computerId", "computerId"),
    ):
        expected = snapshot_team_id(snapshot) if session_key == "teamId" else snapshot.get(team_key)
        if (session_key != "teamId" and not session.get(session_key)) or session.get(session_key) != expected:
            raise ValueError("workflow_scope_mismatch")
    assignments = workflow_work_graph(assignments, team_snapshot=snapshot)
    if any(item["workflowAttempt"] != 1 for item in assignments):
        raise ValueError("workflow_initial_attempt_invalid")
    run_id = assignments[0]["workflowRunId"]
    runs = session.get("workflowRuns") or []
    if any(run["workflowRunId"] == run_id for run in runs):
        raise ValueError("workflow_run_exists")
    if any(run["status"] not in ("completed", "cancelled") for run in runs):
        raise ValueError("workflow_run_in_flight")
    run = {
        "workflowRunId": run_id, "teamSnapshot": deepcopy(snapshot),
        **({"workflowSnapshot": deepcopy(snapshot)} if snapshot.get("workflowRecordVersion") == 1 else {}),
        "assignments": assignments, "currentIndex": 0, "revision": 0,
        "status": "awaiting_approval" if assignments[0]["awaitApproval"] else "ready",
        "gateDecisions": [], "startedAt": event["timestamp"],
        # A later run in the same thread may carry a re-worded Task goal; the
        # first run's goal is the thread's own.
        **({"taskGoal": event["taskGoal"]} if isinstance(event.get("taskGoal"), str) else {}),
    }
    session["workflowRuns"] = [*runs, run]
    session["activeWorkflowRunId"] = run_id


def apply_workflow_gate_decided(session: dict[str, Any], event: dict[str, Any]) -> None:
    """Record one current-attempt gate answer; rejection does not skip work."""
    _assert_session_open(session, event)
    run_id = event.get("workflowRunId")
    if not run_id or session.get("activeWorkflowRunId") != run_id:
        raise ValueError("workflow_run_mismatch")
    runs = session.get("workflowRuns") or []
    current = next((run for run in runs if run["workflowRunId"] == run_id), None)
    if current is None:
        raise ValueError("workflow_run_missing")
    if type(event.get("expectedRevision")) is not int or event["expectedRevision"] != current["revision"]:
        raise ValueError("workflow_stale_revision")
    if current["status"] != "awaiting_approval":
        raise ValueError("workflow_gate_closed")
    assignment = current["assignments"][current["currentIndex"]]
    for key in ("workflowStepId", "workflowAttempt", "assignmentId"):
        if type(event.get(key)) is not type(assignment[key]) or event.get(key) != assignment[key]:
            raise ValueError("workflow_attempt_mismatch")
    if not event.get("actorUserId") or event["actorUserId"] != session.get("ownerUserId"):
        raise ValueError("workflow_owner_required")
    if event.get("kind") not in ("approve", "reject"):
        raise ValueError("workflow_gate_decision_invalid")
    updated = deepcopy(current)
    updated["status"] = "ready" if event["kind"] == "approve" else "blocked"
    updated["revision"] += 1
    updated["gateDecisions"].append(deepcopy(event))
    session["workflowRuns"] = [updated if run is current else run for run in runs]


def current_workflow_attempt(session: dict[str, Any], event: dict[str, Any]) -> dict[str, Any]:
    """Fence every transition by revision and the current frozen attempt."""
    _assert_session_open(session, event)
    run_id = event.get("workflowRunId")
    current = next((run for run in session.get("workflowRuns", [])
                    if run["workflowRunId"] == run_id), None)
    if not current or session.get("activeWorkflowRunId") != run_id:
        raise ValueError("workflow_run_mismatch")
    if type(event.get("expectedRevision")) is not int or event["expectedRevision"] != current["revision"]:
        raise ValueError("workflow_stale_revision")
    assignment = current["assignments"][current["currentIndex"]]
    for key in ("workflowStepId", "workflowAttempt", "assignmentId"):
        if type(event.get(key)) is not type(assignment[key]) or event.get(key) != assignment[key]:
            raise ValueError("workflow_attempt_mismatch")
    return current


def apply_workflow_step_finished(session: dict[str, Any], event: dict[str, Any]) -> None:
    current = current_workflow_attempt(session, event)
    if current["status"] != "ready":
        raise ValueError("workflow_step_not_ready")
    assignment = current["assignments"][current["currentIndex"]]
    evidence = event.get("terminalEvent")
    if not isinstance(evidence, dict) or not evidence.get("runId") or not evidence.get("commandId"):
        raise ValueError("workflow_terminal_evidence_required")
    # agent.completed is written in the same transaction, before this event.
    if not any(run["id"] == evidence["runId"] and run.get("assignmentId") == assignment["assignmentId"]
               and run.get("status") in ("completed", "failed", "cancelled")
               for run in session.get("agentRuns", [])):
        raise ValueError("workflow_terminal_run_mismatch")
    # Replaying an older event must reconstruct the reason originally recorded.
    result = workflow_step_result(assignment, evidence, report_diagnostics=event.get("reportDiagnostics") is True)
    updated = deepcopy(current)
    updated.setdefault("attemptResults", []).append({
        **{key: assignment[key] for key in ("workflowStepId", "workflowAttempt", "assignmentId")},
        "runId": evidence["runId"], "commandId": evidence["commandId"],
        "timestamp": event["timestamp"], **result,
    })
    updated["revision"] += 1
    if result["status"] == "succeeded":
        if current["currentIndex"] + 1 == len(current["assignments"]):
            updated["status"] = "completed"
        else:
            updated["currentIndex"] += 1
            successor = updated["assignments"][updated["currentIndex"]]
            updated["status"] = "awaiting_approval" if successor["awaitApproval"] else "ready"
    elif result["status"] == "question":
        updated["status"] = "awaiting_input"
    else:
        updated["status"] = "blocked"
    session["workflowRuns"] = [updated if run is current else run for run in session["workflowRuns"]]


ANSWER_LIMIT = 4000


def workflow_answer_text(value: Any) -> str:
    if not isinstance(value, str) or not value.strip() or len(value) > ANSWER_LIMIT:
        raise ValueError("workflow_answer_invalid")
    return value.strip()


def apply_workflow_recovery_decided(session: dict[str, Any], event: dict[str, Any]) -> None:
    current = current_workflow_attempt(session, event)
    if not event.get("actorUserId") or event["actorUserId"] != session.get("ownerUserId"):
        raise ValueError("workflow_owner_required")
    updated = deepcopy(current)
    if event.get("kind") == "retry":
        if current["status"] != "blocked":
            raise ValueError("workflow_retry_requires_blocked_attempt")
        index = current["currentIndex"]
        updated.pop("admissionError", None)
        updated["assignments"][index] = retry_workflow_assignment(current["assignments"][index])
        updated["status"] = "awaiting_approval" if updated["assignments"][index]["awaitApproval"] else "ready"
    elif event.get("kind") == "answer":
        # The owner answered the step's question: rerun the step as a new
        # attempt that carries the answer. Answering is the owner's consent
        # for this step, so an approval gate is not asked again.
        if current["status"] != "awaiting_input":
            raise ValueError("workflow_answer_requires_question")
        workflow_answer_text(event.get("answer"))
        index = current["currentIndex"]
        updated["assignments"][index] = retry_workflow_assignment(current["assignments"][index])
        updated["status"] = "ready"
    elif event.get("kind") == "cancel":
        if current["status"] in ("completed", "cancelled"):
            raise ValueError("workflow_run_closed")
        updated["status"] = "cancelled"
    else:
        raise ValueError("workflow_recovery_decision_invalid")
    updated["revision"] += 1
    updated.setdefault("recoveryDecisions", []).append(deepcopy(event))
    session["workflowRuns"] = [updated if run is current else run for run in session["workflowRuns"]]


def apply_workflow_interrupted(session: dict[str, Any], event: dict[str, Any]) -> None:
    """An owner assertion makes this attempt retryable, never successful."""
    current = current_workflow_attempt(session, event)
    if current["status"] != "ready" or event.get("actorUserId") != session.get("ownerUserId"):
        raise ValueError("workflow_reconciliation_invalid")
    updated = deepcopy(current)
    updated["status"] = "blocked"
    updated["revision"] += 1
    updated.setdefault("interruptions", []).append(deepcopy(event))
    session["workflowRuns"] = [updated if run is current else run for run in session["workflowRuns"]]


def apply_workflow_admission_blocked(session: dict[str, Any], event: dict[str, Any]) -> None:
    current = current_workflow_attempt(session, event)
    if current["status"] != "ready":
        raise ValueError("workflow_step_not_ready")
    updated = deepcopy(current)
    updated["status"] = "blocked"
    updated["revision"] += 1
    updated["admissionError"] = str(event["reason"])[:2000]
    session["workflowRuns"] = [updated if run is current else run for run in session["workflowRuns"]]
