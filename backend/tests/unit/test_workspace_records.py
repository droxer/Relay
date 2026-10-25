import pytest

from relay.sessions.handoff_files import handoff_file
from relay.daemon_registry.runs.artifacts import is_snapshotable_path
from relay.daemon_registry.dispatch.run_state import _DeliveryRefused, _handoff_context_state


@pytest.mark.parametrize("layout", ["thread", "task", "project", "node-root"])
def test_every_thread_has_its_own_record_directory(layout):
    assert handoff_file("ses_one", layout) == ".threads/ses_one/HANDOFF.md"
    assert handoff_file("ses_two", layout) == ".threads/ses_two/HANDOFF.md"


@pytest.mark.parametrize("path", [
    "artifacts/report.md", "artifacts/nested/data.json",
    ".threads/ses_one/HANDOFF.md", ".threads/ses_one/HANDOFF.json",
    "threads/ses_one/HANDOFF.md", "threads/ses_one/HANDOFF.json",
])
def test_artifacts_and_thread_checkpoints_keep_durable_snapshots(path):
    assert is_snapshotable_path(path)


def test_checkout_text_is_still_metadata_only():
    assert not is_snapshotable_path("checkout/README.md")


@pytest.mark.parametrize("records_dir", ["threads", ".threads"])
@pytest.mark.parametrize("supports_dot_threads", [False, True])
def test_accepted_handoff_requires_support_for_its_record_layout(records_dir, supports_dot_threads):
    context = {
        "contract": {"name": "relay.handoff.context", "version": 1},
        "assignmentId": "receiver", "objective": "continue", "priorContext": "notes",
        "progressFile": f"{records_dir}/ses_one/HANDOFF.md",
    }
    sandbox = {"capabilities": ["dot-thread-records"] if supports_dot_threads else []}
    if records_dir == ".threads" and not supports_dot_threads:
        with pytest.raises(_DeliveryRefused, match="dot-thread-records.*[Uu]pgrade"):
            _handoff_context_state({}, context, sandbox, {"assignmentId": "receiver"}, "thread", None)
    else:
        state, _ = _handoff_context_state({}, context, sandbox, {"assignmentId": "receiver"}, "thread", None)
        assert state["progress_file"] == context["progressFile"]
