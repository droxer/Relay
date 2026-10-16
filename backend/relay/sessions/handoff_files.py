"""Names of the handoff notes a thread's agents keep in the shared workspace.

`HANDOFF.md` is the free-form record every agent reads before it starts and
updates before it finishes; `HANDOFF.json` beside it is the structured
checkpoint a handoff receipt validates. Both were once `PROGRESS.md` and
`PROGRESS.md.handoff.json`: a handoff context accepted before the rename still
carries the old name, and its checkpoint keeps the old suffix so the receipt
looks where that agent was told to write. The prompt side mirrors these rules
in `relay-core/src/handoff-files.ts`.
"""

from __future__ import annotations

HANDOFF_FILE = "HANDOFF.md"
_STEM = "HANDOFF"
_LEGACY_STEM = "PROGRESS"
_LEGACY_CHECKPOINT_SUFFIX = ".handoff.json"


def handoff_file(session_id: str, workspace_layout: str) -> str:
    """Name the handoff notes for a thread, without colliding with other threads.

    A thread workspace holds one thread, so the plain name is unambiguous there.
    A node-root workspace is shared by every thread that ever ran on the node,
    where one `HANDOFF.md` would hand the next task the previous task's notes.
    """
    if workspace_layout == "thread":
        return HANDOFF_FILE
    return f"{_STEM}-{session_id}.md"


def handoff_checkpoint_file(notes_file: str) -> str:
    """Name the structured checkpoint that sits beside a handoff notes file."""
    if notes_file.startswith(_LEGACY_STEM) or not notes_file.endswith(".md"):
        return notes_file + _LEGACY_CHECKPOINT_SUFFIX
    return notes_file.removesuffix(".md") + ".json"
