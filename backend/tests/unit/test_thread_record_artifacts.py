"""Continuity records are not deliverables in task and automation Files."""

from __future__ import annotations

import pytest

from relay.core.workspace_artifacts import is_thread_record_artifact


@pytest.mark.parametrize("root", [".relay/threads", ".threads", "threads"])
@pytest.mark.parametrize("name", ["HANDOFF.md", "HANDOFF.json"])
@pytest.mark.parametrize("relative_field", [True, False])
def test_recognizes_current_and_legacy_thread_records(root, name, relative_field):
    path = f"{root}/run-1/{name}"
    artifact = {"path": f"/workspace/{path}", "title": name}
    if relative_field:
        artifact["workspaceRelativePath"] = path
    assert is_thread_record_artifact({"workspacePath": "/workspace"}, artifact)


@pytest.mark.parametrize("path", [
    "artifacts/run-1/HANDOFF.md",
    "artifacts/run-1/HANDOFF.json",
    "HANDOFF.md",
    "docs/HANDOFF.json",
    "threads/module.py",
    ".relay/threads/run-1/nested/HANDOFF.md",
])
def test_keeps_user_deliverables_even_with_a_handoff_title(path):
    assert not is_thread_record_artifact({}, {
        "workspaceRelativePath": path, "title": "HANDOFF.md",
    })


def test_recognizes_windows_paths_on_any_backend_host():
    assert is_thread_record_artifact({"workspacePath": "C:/work"}, {
        "path": r"C:\work\.relay\threads\run-1\HANDOFF.json",
    })


def test_prefers_relative_path_over_unrelated_stored_path():
    assert not is_thread_record_artifact({"workspacePath": "/workspace"}, {
        "workspaceRelativePath": "artifacts/HANDOFF.md",
        "path": "/workspace/.relay/threads/run-1/HANDOFF.md",
    })


@pytest.mark.parametrize("artifact", [{}, {"path": None}, {"title": "HANDOFF.md"}])
def test_leaves_records_without_a_known_path_visible(artifact):
    assert not is_thread_record_artifact({}, artifact)
