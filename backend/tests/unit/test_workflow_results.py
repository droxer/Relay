"""Workflow success requires an explicit report and every named recorded output."""
from copy import deepcopy

import pytest

from relay.collaboration.workflow_results import workflow_step_result


def completion(**patch):
    return {"type": "run.completed", "runId": "run", "exitCode": 0,
            "roundResult": {"runId": "run", "status": "done", "work": {
                "status": "done", "evidence": ["verified"],
                "outputs": {"Design": "docs/design.md: reviewed design"},
            }}, **patch}


def test_success_preserves_named_output_without_mutating_report():
    event = completion()
    before = deepcopy(event)
    result = workflow_step_result({"expectedOutputs": ["Design"]}, event)
    assert result["status"] == "succeeded"
    assert result["outputs"] == {"Design": "docs/design.md: reviewed design"}
    assert event == before


@pytest.mark.parametrize("change", ["missing", "failure", "exit", "stale", "output", "empty", "findings", "truncated"])
def test_non_success_never_accepts_outputs(change):
    event = completion()
    if change == "missing":
        event.pop("roundResult")
    elif change == "failure":
        event["roundResult"]["work"]["status"] = "blocked"
    elif change == "exit":
        event["exitCode"] = 1
    elif change == "stale":
        event["roundResult"]["runId"] = "previous"
    elif change == "output":
        event["roundResult"]["work"]["outputs"] = {"Other": "irrelevant"}
    elif change == "empty":
        event["roundResult"]["work"]["outputs"] = {"Design": " "}
    elif change == "findings":
        event["roundResult"]["work"]["findings"] = [{"workItemId": "x", "note": "broken"}]
    else:
        event["outputTruncated"] = True
    assert workflow_step_result({"expectedOutputs": ["Design"]}, event)["status"] == "blocked"


@pytest.mark.parametrize("outputs", [None, {}])
def test_criteria_only_step_accepts_completion_evidence_without_named_outputs(outputs):
    event = completion()
    work = event["roundResult"]["work"]
    if outputs is None:
        del work["outputs"]
    else:
        work["outputs"] = outputs
    result = workflow_step_result({"expectedOutputs": [], "acceptanceCriteria": ["Tests pass"]}, event)
    assert result["status"] == "succeeded"
    assert result["evidence"] == ["verified"]
    assert result["outputs"] == {}


def test_criteria_only_step_still_requires_completion_evidence():
    event = completion()
    event["roundResult"]["work"] = {"status": "done"}
    assert workflow_step_result({"expectedOutputs": []}, event)["status"] == "blocked"
