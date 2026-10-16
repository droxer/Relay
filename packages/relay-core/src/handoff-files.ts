/**
 * Names of the handoff notes a thread's agents keep in the shared workspace.
 *
 * The backend picks the notes file (`HANDOFF.md`, or `HANDOFF-<sessionId>.md`
 * in a shared node root) and sends it as `progress_file`; these helpers derive
 * the names beside it. They mirror `backend/relay/sessions/handoff_files.py`:
 * the backend validates the checkpoint at the path the prompt names.
 */

const STEM = "HANDOFF";
const LEGACY_STEM = "PROGRESS";
const LEGACY_CHECKPOINT_SUFFIX = ".handoff.json";

/** The structured checkpoint beside a notes file: `HANDOFF.md` → `HANDOFF.json`.
 * A pre-rename `PROGRESS*.md` keeps its old `.handoff.json` suffix. */
export function handoffCheckpointFile(notesFile: string): string {
  if (notesFile.startsWith(LEGACY_STEM) || !notesFile.endsWith(".md")) {
    return notesFile + LEGACY_CHECKPOINT_SUFFIX;
  }
  return `${notesFile.slice(0, -".md".length)}.json`;
}

/** The pre-rename name of a notes file, which a task started before the
 * rename may still have in its workspace; undefined when there is none. */
export function legacyHandoffFile(notesFile: string): string | undefined {
  return notesFile.startsWith(STEM) ? LEGACY_STEM + notesFile.slice(STEM.length) : undefined;
}
