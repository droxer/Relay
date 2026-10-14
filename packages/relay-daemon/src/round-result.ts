import { readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import type { DaemonRoundResultRejectionReason } from "relay-core";

/**
 * A round's own statement of where the task stands, written by the agent.
 *
 * The transcript cannot answer "is this finished?" without parsing prose, and
 * an exit code only says the CLI ran. This file is the one machine-readable
 * answer, so the control plane never has to guess from output text.
 */
interface RoundResult {
  work?: Record<string, unknown>;
  status: "done" | "continue" | "blocked";
  note?: string;
  /** Answers a blocked round offers its human; the backend validates them. */
  options?: string[];
  /** Lines proposed for the project's context; the backend validates them. */
  contextSuggestions?: Array<{ text: string; evidence?: string }>;
}

/** Workspace-relative path the agent writes. `.relay/` is excluded from the
 * artifact scan, so this control file never shows up as a deliverable. */
export const ROUND_RESULT_RELATIVE_PATH = join(".relay", "round-result.json");
/** A status line, not a report: anything larger is malformed. */
const ROUND_RESULT_MAX_BYTES = 64 * 1024;
const ROUND_RESULT_STATUSES = new Set(["done", "continue", "blocked"]);
const NOTE_MAX_CHARS = 2000;
const OPTIONS_MAX = 6;
const OPTION_MAX_CHARS = 200;
const CONTEXT_SUGGESTIONS_MAX = 3;
const CONTEXT_SUGGESTION_MAX_CHARS = 500;

/** What a run's control file amounted to. Only a present file can be rejected. */
export type RoundResultOutcome =
  | { kind: "absent" }
  | { kind: "accepted"; result: RoundResult }
  | { kind: "rejected"; reason: DaemonRoundResultRejectionReason };

type ParsedRoundResult = Exclude<RoundResultOutcome, { kind: "absent" }>;

/**
 * Read and consume the round result a run left behind, if any.
 *
 * The file is removed after reading: it describes the round that just ended,
 * and leaving it in place would let a later round inherit a stale verdict —
 * the failure mode where a task reports "done" because a previous round said
 * so. A broken control file must not fail an otherwise successful run, but
 * it must not vanish either: the outcome names why it was refused, so a
 * human's question is never dropped without a trace.
 */
export function readRoundResult(workspacePath: string, expectedRunId?: string): RoundResultOutcome {
  const path = join(workspacePath, ROUND_RESULT_RELATIVE_PATH);
  let raw: string;
  try {
    if (statSync(path).size > ROUND_RESULT_MAX_BYTES) {
      removeQuietly(path);
      return { kind: "rejected", reason: "oversize" };
    }
    raw = readFileSync(path, "utf8");
  } catch {
    return { kind: "absent" };
  }
  removeQuietly(path);
  return evaluateRoundResult(raw, expectedRunId);
}

/** {@link readRoundResult} for callers that only need an accepted verdict. */
export function consumeRoundResult(workspacePath: string, expectedRunId?: string): RoundResult | undefined {
  const outcome = readRoundResult(workspacePath, expectedRunId);
  return outcome.kind === "accepted" ? outcome.result : undefined;
}

export function parseRoundResult(raw: string, expectedRunId?: string): RoundResult | undefined {
  const outcome = evaluateRoundResult(raw, expectedRunId);
  return outcome.kind === "accepted" ? outcome.result : undefined;
}

export function evaluateRoundResult(raw: string, expectedRunId?: string): ParsedRoundResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { kind: "rejected", reason: "malformed" };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { kind: "rejected", reason: "not_object" };
  }
  const { status, note, runId, work, options, contextSuggestions } = parsed as { status?: unknown; note?: unknown; runId?: unknown; work?: unknown; options?: unknown; contextSuggestions?: unknown };
  if (expectedRunId !== undefined && runId !== expectedRunId) return { kind: "rejected", reason: "run_id_mismatch" };
  if (typeof status !== "string" || !ROUND_RESULT_STATUSES.has(status)) {
    return { kind: "rejected", reason: "invalid_status" };
  }
  return {
    kind: "accepted",
    result: {
      status: status as RoundResult["status"],
      ...(work && typeof work === "object" && !Array.isArray(work) ? { work: work as Record<string, unknown> } : {}),
      ...(typeof note === "string" && note.trim()
        ? { note: note.trim().slice(0, NOTE_MAX_CHARS) }
        : {}),
      ...(status === "blocked" && Array.isArray(options)
        ? { options: options.filter((item): item is string => typeof item === "string").slice(0, OPTIONS_MAX).map((item) => item.slice(0, OPTION_MAX_CHARS)) }
        : {}),
      ...contextSuggestionsField(contextSuggestions),
    },
  };
}

function contextSuggestionsField(raw: unknown): Pick<RoundResult, "contextSuggestions"> {
  if (!Array.isArray(raw)) return {};
  const suggestions = raw
    .filter((item): item is { text: string; evidence?: unknown } => (
      Boolean(item) && typeof item === "object" && typeof (item as { text?: unknown }).text === "string"
    ))
    .map((item) => ({
      text: item.text.trim().slice(0, CONTEXT_SUGGESTION_MAX_CHARS),
      ...(typeof item.evidence === "string" && item.evidence.trim()
        ? { evidence: item.evidence.trim().slice(0, CONTEXT_SUGGESTION_MAX_CHARS) }
        : {}),
    }))
    .filter((item) => item.text)
    .slice(0, CONTEXT_SUGGESTIONS_MAX);
  return suggestions.length ? { contextSuggestions: suggestions } : {};
}

function removeQuietly(path: string): void {
  try {
    rmSync(path, { force: true });
  } catch {
    // A workspace we cannot write to still produced a usable verdict.
  }
}
