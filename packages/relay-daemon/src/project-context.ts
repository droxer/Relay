import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** Workspace-relative mirror of the project brief. `.relay/` is excluded from
 * the artifact scan, so the mirror never shows up as a deliverable. */
export const PROJECT_CONTEXT_RELATIVE_PATH = join(".relay", "PROJECT.md");

/**
 * Mirror the brief the run was dispatched with into the project workspace.
 *
 * The prompt already carries it; the file lets an agent re-read the brief
 * mid-run and gives file-reading CLIs the same context natively. It is
 * rewritten every run from the round's pinned snapshot, so an edit made in
 * the workspace never outlives the run, and it is removed when the run has
 * no brief so a stale copy cannot speak for a project that changed.
 */
export function syncProjectContext(workspacePath: string, layout: string | undefined, brief: string | undefined): void {
  const path = join(workspacePath, PROJECT_CONTEXT_RELATIVE_PATH);
  if (layout !== "project") return;
  if (!brief?.trim()) {
    rmSync(path, { force: true });
    return;
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(
    path,
    `<!-- Written by Relay from the project's settings for this run. Edit the project, not this file. -->\n\n${brief.trim()}\n`,
    "utf8",
  );
}
