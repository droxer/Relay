"""Names of the handoff notes a thread's agents keep in the shared workspace.

`.relay/threads/<threadId>/HANDOFF.md` (using `<routineId>` for automation runs)
is the free-form record every agent reads before it starts and
updates before it finishes; `HANDOFF.json` beside it is the structured
checkpoint a handoff receipt validates. Both were once `PROGRESS.md` and
`PROGRESS.md.handoff.json`: a handoff context accepted before the rename still
carries the old name, and its checkpoint keeps the old suffix so the receipt
looks where that agent was told to write. The prompt side mirrors these rules
in `relay-core/src/handoff-files.ts`.
"""

from __future__ import annotations

from typing import Any

from ..core.workspace_layout import THREAD_RECORDS_DIR, THREAD_RECORDS_DIRS

HANDOFF_FILE = "HANDOFF.md"
_STEM = "HANDOFF"
_LEGACY_STEM = "PROGRESS"
_LEGACY_CHECKPOINT_SUFFIX = ".handoff.json"


def handoff_file(
    session_id: str, workspace_layout: str, *, records_dir: str = THREAD_RECORDS_DIR,
    task: dict[str, Any] | None = None,
) -> str:
    """Name the notes shared by an automation's runs, or owned by one thread.

    Automation identity keeps unrelated automations in a project separate.
    workspace_layout remains an argument for callers and older stored contexts;
    records_dir is the directory the receiving daemon keeps records in.
    """
    routine_id = (task or {}).get("sourceRoutineId")
    records_id = routine_id if isinstance(routine_id, str) and routine_id else session_id
    return f"{records_dir}/{records_id}/{HANDOFF_FILE}"


def records_handoff_files(session_id: str, *, task: dict[str, Any] | None = None) -> tuple[str, ...]:
    """Every records-directory name for these handoff notes, newest first."""
    return tuple(handoff_file(session_id, "", records_dir=directory, task=task) for directory in THREAD_RECORDS_DIRS)


def handoff_checkpoint_file(notes_file: str) -> str:
    """Name the structured checkpoint that sits beside a handoff notes file."""
    if notes_file.startswith(_LEGACY_STEM) or not notes_file.endswith(".md"):
        return notes_file + _LEGACY_CHECKPOINT_SUFFIX
    return notes_file.removesuffix(".md") + ".json"


def legacy_handoff_checkpoint_file(notes_file: str) -> str | None:
    """Where a run dispatched before the rename wrote this notes file's checkpoint.

    A handoff captured after the deploy names the new notes file, but the run
    it hands off from was told `PROGRESS[-<id>].md`; without this its
    checkpoint reads as missing.
    """
    if not notes_file.startswith(_STEM) or not notes_file.endswith(".md"):
        return None
    return _LEGACY_STEM + notes_file.removeprefix(_STEM) + _LEGACY_CHECKPOINT_SUFFIX
