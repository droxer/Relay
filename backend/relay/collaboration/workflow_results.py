"""Workflow-only acceptance of daemon-carried, run-bound completion evidence.

Evidence and optional outputs are attributed reports, not backend verification.
No legacy completion, delegation, consultation or automatic repair policy applies.
"""
from __future__ import annotations

from typing import Any

from .policy import is_question, round_result_options
from .work import validate_work_result

QUESTION_LIMIT = 2000


def workflow_step_result(assignment: dict[str, Any], event: dict[str, Any]) -> dict[str, Any]:
    blocked = {"status": "blocked", "reason": "workflow_result_required", "outputs": {}}
    if event.get("type") not in ("run.completed", "run.failed"):
        return {**blocked, "reason": "workflow_execution_failed"}
    if event.get("outputTruncated") or event.get("roundResultRejected"):
        return {**blocked, "reason": "workflow_result_incomplete"}
    report = event.get("roundResult")
    question = _question(report, event)
    if question:
        return question
    if event.get("type") != "run.completed" or event.get("exitCode") != 0:
        return {**blocked, "reason": "workflow_execution_failed"}
    if not isinstance(report, dict) or report.get("runId") != event.get("runId") or report.get("status") != "done":
        return blocked
    work = report.get("work")
    if not isinstance(work, dict):
        return blocked
    result = validate_work_result(work)
    if not result or result["status"] != "done" or result.get("plan") or result.get("delegation"):
        return blocked
    outputs = work.get("outputs", {})
    if not isinstance(outputs, dict) or len(outputs) > 32 or any(
        not isinstance(key, str) or not key.strip() or len(key) > 2000
        or not isinstance(value, str) or not value.strip() or len(value) > 8000
        for key, value in outputs.items()
    ):
        return {**blocked, "reason": "workflow_outputs_required"}
    if sum(len(key) + len(value) for key, value in outputs.items()) > 65536:
        return {**blocked, "reason": "workflow_outputs_too_large"}
    if any(name not in outputs for name in assignment.get("expectedOutputs", [])):
        return {**blocked, "reason": "workflow_outputs_required"}
    return {"status": "succeeded", "outputs": dict(outputs),
            "evidence": result["evidence"], "note": result["note"]}


def _question(report: Any, event: dict[str, Any]) -> dict[str, Any] | None:
    """A step that stopped to ask its owner waits for an answer, not a retry.

    Like a thread round, the question parks even if the CLI then exits
    non-zero: the agent said what it needs before it stopped.
    """
    if not isinstance(report, dict) or report.get("runId") != event.get("runId") or not is_question(report):
        return None
    options = round_result_options(report.get("options"))
    note = report.get("note")
    text = note.strip()[:QUESTION_LIMIT] if isinstance(note, str) else ""
    if not text and not options:
        return None
    return {"status": "question", "reason": "workflow_question", "outputs": {},
            "question": text, "options": options}
