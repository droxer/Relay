import { readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { NEXT_STEPS_RELATIVE_PATH, sanitizeNextSteps } from "relay-core";

/** A few short lines; anything larger is malformed. */
const NEXT_STEPS_MAX_BYTES = 8 * 1024;

/**
 * Read and remove the next steps a run suggested, if any.
 *
 * Removed on every terminal path, so a later run cannot report a stale
 * suggestion as its own. A missing, oversized, or malformed file is simply no
 * suggestion: it never fails the run.
 */
export function consumeNextSteps(workspacePath: string): string[] {
  const path = join(workspacePath, NEXT_STEPS_RELATIVE_PATH);
  let raw: string;
  try {
    raw = statSync(path).size > NEXT_STEPS_MAX_BYTES ? "" : readFileSync(path, "utf8");
  } catch {
    return [];
  }
  try {
    rmSync(path, { force: true });
  } catch {
    // A file that cannot be removed is still read once; the next run overwrites it.
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? sanitizeNextSteps((parsed as { nextSteps?: unknown }).nextSteps)
      : [];
  } catch {
    return [];
  }
}
