"""Fence generic workflow execution, progression and staged-command recovery.

W2a/W2b use dedicated ledger-bound admission, progression and owner recovery.
They do not authorize legacy preparation or delivery through this boundary.
Rejection here neither terminalizes a request nor releases a reservation.
"""
from __future__ import annotations

from typing import Any

from ...core.team_workflows import is_workflow_team


def assert_workflow_runtime_supported(request: dict[str, Any]) -> None:
    manifest = (request.get("state") or {}).get("_relay_collaboration_manifest") or {}
    assignments = [*(request.get("assignments") or []), *(manifest.get("assignments") or [])]
    graph = manifest.get("workGraph") or {}
    if (
        is_workflow_team(manifest.get("teamSnapshot") or {})
        or (graph.get("delegationPolicy") or {}).get("policy") == "project-workflow-v1"
        or any(
            any(key in item for key in ("workflowRunId", "workflowStepId", "workflowAttempt"))
            or item.get("workKind") == "workflow_step"
            or is_workflow_team(item.get("teamSnapshot") or {})
            for item in assignments
        )
    ):
        raise ValueError("team_workflow_execution_unavailable")
