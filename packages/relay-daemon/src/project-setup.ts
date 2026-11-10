import { join } from "node:path";
import { consumeControlFile } from "./control-file.js";

/** Legacy path, still accepted for commands from an older backend.
 * Current commands specify `.relay/project-setup-<runId>.json` in their state.
 * `.relay/` is excluded from the artifact scan, so the proposal never shows up
 * as a deliverable. */
export const PROJECT_SETUP_RELATIVE_PATH = join(".relay", "project-setup.json");
/** A roster, a brief, and a few tasks — anything larger is malformed. */
const PROJECT_SETUP_MAX_BYTES = 256 * 1024;

/**
 * Read and remove the setup proposal a run left behind, if any.
 *
 * Removed after reading so a later round cannot report a stale proposal as
 * its own. The daemon passes the object through unvalidated: the backend owns
 * the proposal's shape. Returns undefined when absent, oversized, or not a
 * JSON object.
 */
export function consumeProjectSetup(workspacePath: string, file: string | undefined): Record<string, unknown> | undefined {
  // Only a setup command supplies a file. Keep legacy backend commands readable,
  // while confining newer attempt-specific paths to the same control directory.
  if (!file || !/^\.relay\/project-setup(?:-[a-zA-Z0-9_-]+)?\.json$/.test(file)) return undefined;
  const content = consumeControlFile(workspacePath, file, PROJECT_SETUP_MAX_BYTES);
  if (content.kind !== "read") return undefined;
  try {
    const parsed: unknown = JSON.parse(content.text);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : undefined;
  } catch {
    return undefined;
  }
}
