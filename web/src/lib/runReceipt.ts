import type { DerivedMessage } from "./projectMessages.ts";
import { freshTokens } from "./tokenUsage.ts";

type AgentTurn = Extract<DerivedMessage, { kind: "agent" }>;

export type RunOutcome = NonNullable<AgentTurn["outcome"]>;

/**
 * The ledger a finished turn closes with: how it ended, how long it took,
 * and what it cost. Fresh tokens are the headline (input, output, cache
 * writes); cache reads stay in the hover breakdown because they dominate a
 * long run while costing a tenth of input — the same rule as every headline.
 * Files are left out: the turn's own files chip already counts them.
 */
export type RunReceipt = {
  outcome: RunOutcome;
  exitCode?: number;
  /** Null when either end of the run carries no readable time. */
  durationMs: number | null;
  /** Null when the runtime reported no counts. */
  tokens: { fresh: number } | null;
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
      ? { fresh: freshTokens(message.tokenUsage) }
      : null,
  };
}
