"""Workspace path conventions shared by the backend and the daemon."""

from __future__ import annotations

from typing import Any

# A project that links an existing directory lives at `links/<id>` (never
# `projects/<id>`); only the daemon maps that subpath to the real directory.
LINKED_WORKSPACE_PREFIX = "links/"

# Every backlog task and automation directory sits under this root.
TASK_WORKSPACE_ROOT = "tasks"
# Each thread's records (`HANDOFF.md`, `HANDOFF.json`) sit in `<dir>/<threadId>/`
# inside its workspace, beside Relay's other control files in `.relay/`. Older
# runs left them in `.threads/` and, before that, `threads/`. The daemon mirrors
# all three in `thread-workspace.ts`.
THREAD_RECORDS_DIR = ".relay/threads"
DOT_THREAD_RECORDS_DIR = ".threads"
LEGACY_THREAD_RECORDS_DIR = "threads"
# Newest first: where a thread's records may sit in a workspace.
THREAD_RECORDS_DIRS = (THREAD_RECORDS_DIR, DOT_THREAD_RECORDS_DIR, LEGACY_THREAD_RECORDS_DIR)
# The deliverables directory inside a thread or task workspace.
ARTIFACTS_DIR = "artifacts"

WORKSPACE_LAYOUT_TASK = "task"
WORKSPACE_LAYOUT_THREAD = "thread"
WORKSPACE_LAYOUT_PROJECT = "project"


def workspace_artifacts_dir(
    layout: str | None, subpath: str | None, *, task: dict[str, Any] | None = None
) -> str | None:
    """Where a run writes deliverables, relative to its workspace.

    None means the workspace itself is the deliverable location: a project
    directory holds its files where they belong, with no `artifacts/`. An
    automation occurrence sharing its automation's directory gets its own
    `artifacts/<taskId>/`; everything else uses `artifacts/`. The daemon
    mirrors the default in `relay-daemon/src/thread-workspace.ts`.
    """
    if layout == WORKSPACE_LAYOUT_PROJECT:
        return None
    routine_id = (task or {}).get("sourceRoutineId")
    if (
        layout == WORKSPACE_LAYOUT_TASK
        and task
        and isinstance(routine_id, str)
        and routine_id
        and subpath == f"{TASK_WORKSPACE_ROOT}/{routine_id}"
    ):
        return f"{ARTIFACTS_DIR}/{task['id']}"
    return ARTIFACTS_DIR
