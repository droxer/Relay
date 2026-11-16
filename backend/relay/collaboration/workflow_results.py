"""Workflow-only acceptance of daemon-carried, run-bound recorded outputs.

Outputs are attributed agent reports, not backend verification of their claims.
No legacy completion, delegation, consultation or automatic repair policy applies.
"""
from __future__ import annotations

from typing import Any

from .work import validate_work_result


def workflow_step_result(assignment: dict[str, Any], event: dict[str, Any]) -> dict[str, Any]:
    blocked = {"status": "blocked", "reason": "workflow_result_required", "outputs": {}}
    if event.get("type") != "run.completed" or event.get("exitCode") != 0:
        return {**blocked, "reason": "workflow_execution_failed"}
    if event.get("outputTruncated") or event.get("roundResultRejected"):
        return {**blocked, "reason": "workflow_result_incomplete"}
    report = event.get("roundResult")
    if not isinstance(report, dict) or report.get("runId") != event.get("runId") or report.get("status") != "done":
        return blocked
    work = report.get("work")
    if not isinstance(work, dict):
        return blocked
    result = validate_work_result(work)
    if not result or result["status"] != "done" or result.get("plan") or result.get("delegation"):
        return blocked
    outputs = work.get("outputs")
    if not isinstance(outputs, dict) or not 1 <= len(outputs) <= 32 or any(
        not isinstance(key, str) or not key.strip() or len(key) > 2000
        or not isinstance(value, str) or not value.strip() or len(value) > 8000
        for key, value in outputs.items()
    ):
        return {**blocked, "reason": "workflow_outputs_required"}
    if sum(len(key) + len(value) for key, value in outputs.items()) > 65536:
        return {**blocked, "reason": "workflow_outputs_too_large"}
    if any(name not in outputs for name in assignment["expectedOutputs"]):
        return {**blocked, "reason": "workflow_outputs_required"}
    return {"status": "succeeded", "outputs": dict(outputs),
            "evidence": result["evidence"], "note": result["note"]}
