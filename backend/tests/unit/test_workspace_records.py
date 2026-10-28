import pytest

from relay.sessions.handoff_files import handoff_file
from relay.daemon_registry.runs.artifacts import is_snapshotable_path
from relay.daemon_registry.dispatch.run_state import (
    _DeliveryRefused,
    _handoff_context_state,
    thread_records_dir,
)


@pytest.mark.parametrize("layout", ["thread", "task", "project", "node-root"])
def test_every_thread_has_its_own_record_directory(layout):
    assert handoff_file("ses_one", layout) == ".relay/threads/ses_one/HANDOFF.md"
    assert handoff_file("ses_two", layout) == ".relay/threads/ses_two/HANDOFF.md"


@pytest.mark.parametrize("layout", ["task", "project"])
def test_automation_runs_share_handoff_records(layout):
    for session_id, task_id in [("ses_one", "task_one"), ("ses_two", "task_two")]:
        task = {"id": task_id, "sourceRoutineId": "routine_nightly"}
        assert handoff_file(session_id, layout, task=task) == ".relay/threads/routine_nightly/HANDOFF.md"
    assert handoff_file("ses_other", layout, task={"sourceRoutineId": "routine_other"}) == (
        ".relay/threads/routine_other/HANDOFF.md"
    )


@pytest.mark.parametrize(("capabilities", "records_dir"), [
    (["relay-thread-records", "dot-thread-records"], ".relay/threads"),
    (["dot-thread-records"], ".threads"),
    ([], "threads"),
])
def test_records_go_where_the_daemon_keeps_them(capabilities, records_dir):
    assert thread_records_dir({"capabilities": capabilities}) == records_dir


@pytest.mark.parametrize("path", [
    "artifacts/report.md", "artifacts/nested/data.json",
    ".relay/threads/ses_one/HANDOFF.md", ".relay/threads/ses_one/HANDOFF.json",
    ".threads/ses_one/HANDOFF.md", ".threads/ses_one/HANDOFF.json",
    "threads/ses_one/HANDOFF.md", "threads/ses_one/HANDOFF.json",
])
def test_artifacts_and_thread_checkpoints_keep_durable_snapshots(path):
    assert is_snapshotable_path(path)


@pytest.mark.parametrize("path", [
    "checkout/README.md", ".relay/notes.md", ".relay/threads/HANDOFF.md",
    ".relay/threads/ses_one/nested/HANDOFF.md", ".relay/threads/ses_one/notes.md",
])
def test_checkout_and_control_text_is_still_metadata_only(path):
    assert not is_snapshotable_path(path)


@pytest.mark.parametrize(("records_dir", "capability"), [
    ("threads", None),
    (".threads", "dot-thread-records"),
    (".relay/threads", "relay-thread-records"),
])
@pytest.mark.parametrize("supported", [False, True])
def test_accepted_handoff_requires_support_for_its_record_layout(records_dir, capability, supported):
    context = {
        "contract": {"name": "relay.handoff.context", "version": 1},
        "assignmentId": "receiver", "objective": "continue", "priorContext": "notes",
        "progressFile": f"{records_dir}/ses_one/HANDOFF.md",
    }
    sandbox = {"capabilities": [capability] if supported and capability else []}
    if capability and not supported:
        with pytest.raises(_DeliveryRefused, match=f"{capability}.*[Uu]pgrade"):
            _handoff_context_state({}, context, sandbox, {"assignmentId": "receiver"}, "thread", None)
    else:
        state, _ = _handoff_context_state({}, context, sandbox, {"assignmentId": "receiver"}, "thread", None)
        assert state["progress_file"] == context["progressFile"]
