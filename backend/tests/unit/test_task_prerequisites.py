"""Task prerequisite rules: same project, acyclic, bounded; done releases."""

from __future__ import annotations

import pytest

from relay.persistence.task.reducer import materialize_task_events
from relay.tasks.prerequisites import (
    PREREQUISITES_MAX,
    PrerequisiteError,
    open_prerequisites,
    prerequisite_ids,
    validate_prerequisites,
)

PROJECT_TASKS = {"a": {}, "b": {}, "c": {}, "r": {"isRoutine": True}}


def _task(task_id: str = "c", **fields) -> dict:
    return {"id": task_id, "projectId": "p1", **fields}


def _code(call) -> str:
    with pytest.raises(PrerequisiteError) as raised:
        call()
    return raised.value.code


def test_ids_are_deduplicated_in_order_and_bounded():
    assert prerequisite_ids([" a", "b", "a", ""]) == ["a", "b"]
    assert _code(lambda: prerequisite_ids("a")) == "task_prerequisites_invalid"
    assert _code(lambda: prerequisite_ids([1])) == "task_prerequisites_invalid"
    too_many = [f"t{index}" for index in range(PREREQUISITES_MAX + 1)]
    assert _code(lambda: prerequisite_ids(too_many)) == "task_prerequisites_too_many"


def test_valid_chain_passes():
    validate_prerequisites(_task("c"), ["b"], PROJECT_TASKS, {"b": ["a"]})


def test_empty_set_always_passes():
    validate_prerequisites({"id": "x", "isRoutine": True}, [], {}, {})


def test_store_validation_enforces_the_prerequisite_limit():
    ids = [f"t{index}" for index in range(PREREQUISITES_MAX + 1)]
    tasks = {task_id: {} for task_id in ids}
    validate_prerequisites(_task(), ids[:PREREQUISITES_MAX], tasks, {})
    assert _code(lambda: validate_prerequisites(_task(), ids, tasks, {})) == "task_prerequisites_too_many"


@pytest.mark.parametrize(
    ("task", "ids", "code"),
    [
        (_task("c"), ["c"], "task_prerequisite_self"),
        (_task("c"), ["elsewhere"], "task_prerequisite_scope"),
        ({"id": "c"}, ["a"], "task_prerequisite_scope"),
        (_task("c"), ["r"], "task_prerequisites_routine"),
        (_task("c", isRoutine=True), ["a"], "task_prerequisites_routine"),
    ],
)
def test_refusals(task, ids, code):
    assert _code(lambda: validate_prerequisites(task, ids, PROJECT_TASKS, {})) == code


def test_cycle_is_refused_through_existing_edges():
    edges = {"b": ["a"], "c": ["b"]}
    refused = lambda: validate_prerequisites(_task("a"), ["c"], PROJECT_TASKS, edges)  # noqa: E731
    assert _code(refused) == "task_prerequisite_cycle"


def test_replacing_a_set_ignores_the_task_own_old_edges():
    # a used to need b; now b needs nothing and a is rewired to c: no cycle.
    validate_prerequisites(_task("a"), ["c"], PROJECT_TASKS, {"a": ["b"], "c": ["b"]})


def test_only_present_unfinished_prerequisites_are_open():
    statuses = {"a": "done", "b": "review"}
    assert open_prerequisites(["a", "b", "gone"], statuses) == ["b"]


def test_reducer_sets_and_clears_the_set():
    created = {"type": "task.created", "taskId": "c", "title": "C", "timestamp": "2026-10-25T00:00:00Z"}
    linked = {
        "type": "task.prerequisites_set", "taskId": "c",
        "prerequisiteTaskIds": ["a", "b"], "timestamp": "2026-10-25T00:00:01Z",
    }
    cleared = {**linked, "prerequisiteTaskIds": [], "timestamp": "2026-10-25T00:00:02Z"}
    assert materialize_task_events([created, linked])["prerequisiteTaskIds"] == ["a", "b"]
    assert "prerequisiteTaskIds" not in materialize_task_events([created, linked, cleared])
