import type { DerivedMessage } from "./projectMessages.ts";
import { freshTokens, splitCache } from "./tokenUsage.ts";

type AgentTurn = Extract<DerivedMessage, { kind: "agent" }>;

export type RunOutcome = NonNullable<AgentTurn["outcome"]>;

/**
 * The ledger a finished turn closes with: how it ended, how long it took,
 * what it cost, and what it left behind. Fresh tokens are the headline (input,
 * output, cache writes); cache reads ride beside them because they dominate a
 * long run while costing a tenth of input — the same rule as every headline.
 */
export type RunReceipt = {
  outcome: RunOutcome;
  exitCode?: number;
  /** Null when either end of the run carries no readable time. */
  durationMs: number | null;
  /** Null when the runtime reported no counts. */
  tokens: { fresh: number; cached: number } | null;
  /** Files the run produced; plans render as their own card, not a file. */
  files: number;
};

export function runReceipt(message: AgentTurn): RunReceipt | null {
  if (message.streaming || !message.outcome) return null;
  const started = Date.parse(message.timestamp);
  const finished = message.finishedAt ? Date.parse(message.finishedAt) : Number.NaN;
  const durationMs = Number.isNaN(started) || Number.isNaN(finished) || finished < started ? null : finished - started;
  return {
    outcome: message.outcome,
    ...(message.exitCode !== undefined ? { exitCode: message.exitCode } : {}),
    durationMs,
    tokens: message.tokenUsage
      ? { fresh: freshTokens(message.tokenUsage), cached: splitCache(message.tokenUsage).cacheRead }
      : null,
    files: message.attachments.filter((artifact) => artifact.kind !== "plan").length,
  };
}
