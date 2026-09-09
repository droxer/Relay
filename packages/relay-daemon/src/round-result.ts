import { readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * A round's own statement of where the task stands, written by the agent.
 *
 * The transcript cannot answer "is this finished?" without parsing prose, and
 * an exit code only says the CLI ran. This file is the one machine-readable
 * answer, so the control plane never has to guess from output text.
 */
export interface RoundResult {
  status: "done" | "continue" | "blocked";
  note?: string;
}

/** Workspace-relative path the agent writes. `.relay/` is excluded from the
 * artifact scan, so this control file never shows up as a deliverable. */
export const ROUND_RESULT_RELATIVE_PATH = join(".relay", "round-result.json");
/** A status line, not a report: anything larger is malformed. */
const ROUND_RESULT_MAX_BYTES = 64 * 1024;
const ROUND_RESULT_STATUSES = new Set(["done", "continue", "blocked"]);
const NOTE_MAX_CHARS = 2000;

/**
 * Read and consume the round result a run left behind, if any.
 *
 * The file is removed after reading: it describes the round that just ended,
 * and leaving it in place would let a later round inherit a stale verdict —
 * the failure mode where a task reports "done" because a previous round said
 * so. Returns undefined when absent or malformed; a broken control file must
 * not fail an otherwise successful run.
 */
export function consumeRoundResult(workspacePath: string, expectedRunId?: string): RoundResult | undefined {
  const path = join(workspacePath, ROUND_RESULT_RELATIVE_PATH);
  let raw: string;
  try {
    if (statSync(path).size > ROUND_RESULT_MAX_BYTES) {
      removeQuietly(path);
      return undefined;
    }
    raw = readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
  removeQuietly(path);
  return parseRoundResult(raw, expectedRunId);
}

export function parseRoundResult(raw: string, expectedRunId?: string): RoundResult | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return undefined;
  }
  const { status, note, runId } = parsed as { status?: unknown; note?: unknown; runId?: unknown };
  if (expectedRunId !== undefined && runId !== expectedRunId) return undefined;
  if (typeof status !== "string" || !ROUND_RESULT_STATUSES.has(status)) {
    return undefined;
  }
  return {
    status: status as RoundResult["status"],
    ...(typeof note === "string" && note.trim()
      ? { note: note.trim().slice(0, NOTE_MAX_CHARS) }
      : {}),
  };
}

function removeQuietly(path: string): void {
  try {
    rmSync(path, { force: true });
  } catch {
    // A workspace we cannot write to still produced a usable verdict.
  }
}
