import type { RelaySession, TokenUsage } from "../types.js";

// Mirrors relay-core/src/token-usage.ts, which the web bundle cannot import.

export function mergeTokenUsage(values: Array<TokenUsage | undefined>): TokenUsage | undefined {
  const totals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  for (const value of values) {
    if (!value) continue;
    const { cacheRead, cacheWrite } = splitCache(value);
    totals.input += value.input;
    totals.output += value.output;
    totals.cacheRead += cacheRead;
    totals.cacheWrite += cacheWrite;
  }
  const cache = totals.cacheRead + totals.cacheWrite;
  if (totals.input === 0 && totals.output === 0 && cache === 0) return undefined;
  return { ...totals, cache, total: totals.input + totals.output + cache };
}

/** Cache read/write; a legacy record's combined `cache` counts as reads. */
export function splitCache(usage: TokenUsage): { cacheRead: number; cacheWrite: number } {
  if (usage.cacheRead === undefined && usage.cacheWrite === undefined) {
    return { cacheRead: usage.cache, cacheWrite: 0 };
  }
  return { cacheRead: usage.cacheRead ?? 0, cacheWrite: usage.cacheWrite ?? 0 };
}

/** The headline count: input, output, and cache writes — everything but cache reads. */
export function freshTokens(usage: TokenUsage): number {
  return usage.total - splitCache(usage).cacheRead;
}

export function sessionTokenUsage(sessions: RelaySession[]): TokenUsage | undefined {
  return mergeTokenUsage(sessions.map((session) => session.tokenUsage));
}

export function formatCompactTokens(value: number, locale?: string): string {
  return new Intl.NumberFormat(locale || undefined, {
    notation: "compact",
    compactDisplay: "short",
    maximumFractionDigits: 1,
  }).format(value);
}
