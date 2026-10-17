import pytest

from relay.sessions.handoff_files import handoff_file
from relay.daemon_registry.artifacts import is_snapshotable_path


@pytest.mark.parametrize("layout", ["thread", "task", "project", "node-root"])
def test_every_thread_has_its_own_record_directory(layout):
    assert handoff_file("ses_one", layout) == "threads/ses_one/HANDOFF.md"
    assert handoff_file("ses_two", layout) == "threads/ses_two/HANDOFF.md"


@pytest.mark.parametrize("path", [
    "artifacts/report.md", "artifacts/nested/data.json",
    "threads/ses_one/HANDOFF.md", "threads/ses_one/HANDOFF.json",
])
def test_artifacts_and_thread_checkpoints_keep_durable_snapshots(path):
    assert is_snapshotable_path(path)


def test_checkout_text_is_still_metadata_only():
    assert not is_snapshotable_path("checkout/README.md")
