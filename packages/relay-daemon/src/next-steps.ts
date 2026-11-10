import { NEXT_STEPS_RELATIVE_PATH, sanitizeNextSteps } from "relay-core";
import { consumeControlFile } from "./control-file.js";

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
  const file = consumeControlFile(workspacePath, NEXT_STEPS_RELATIVE_PATH, NEXT_STEPS_MAX_BYTES);
  if (file.kind !== "read") return [];
  try {
    const parsed: unknown = JSON.parse(file.text);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? sanitizeNextSteps((parsed as { nextSteps?: unknown }).nextSteps)
      : [];
  } catch {
    return [];
  }
}
