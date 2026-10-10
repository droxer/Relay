export interface TokenUsage {
  /** Uncached input tokens. */
  input: number;
  output: number;
  /** cacheRead + cacheWrite; kept so readers that predate the split still add up. */
  cache: number;
  /** Input served from the prompt cache (billed at a fraction of input). Absent on legacy records. */
  cacheRead?: number;
  /** Input written to the prompt cache (billed above input). Absent on legacy records. */
  cacheWrite?: number;
  /** Every token the run processed: input + output + cache. */
  total: number;
  source?: string;
}

const INPUT_KEYS = ["input", "inputTokens", "input_tokens", "promptTokens", "prompt_tokens"];
const OUTPUT_KEYS = ["output", "outputTokens", "output_tokens", "completionTokens", "completion_tokens"];
// Cache counts reported beside input (Claude, Pi). Generic "cache" counts are
// read hits: that is what every runtime reporting a single figure means.
const CACHE_READ_KEYS = [
  "cache",
  "cacheTokens",
  "cache_tokens",
  "cacheReadInputTokens",
  "cache_read_input_tokens",
  "cacheRead",
];
const CACHE_WRITE_KEYS = ["cacheCreationInputTokens", "cache_creation_input_tokens", "cacheWrite"];
// Cache hits reported inside input (Codex, OpenAI); subtracted from input.
const INCLUDED_CACHE_KEYS = ["cachedTokens", "cached_tokens", "cachedInputTokens", "cached_input_tokens"];

export function normalizeTokenUsage(value: unknown, source?: string): TokenUsage | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  const rawInput = sumNumericFields(record, INPUT_KEYS);
  const output = sumNumericFields(record, OUTPUT_KEYS);
  const includedCache =
    sumNumericFields(record, INCLUDED_CACHE_KEYS) +
    sumNestedNumericFields(record, "prompt_tokens_details", ["cached_tokens", "cachedTokens"]);
  const cacheRead = sumNumericFields(record, CACHE_READ_KEYS) + includedCache;
  const cacheWrite = sumNumericFields(record, CACHE_WRITE_KEYS);
  const input = Math.max(0, rawInput - includedCache);
  return buildTokenUsage({ input, output, cacheRead, cacheWrite }, source);
}

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
  return buildTokenUsage(totals);
}

/**
 * Cache read/write for any record. A legacy record carries only the combined
 * `cache`; it is counted as reads, which is what almost all of it was.
 */
export function splitCache(usage: TokenUsage): { cacheRead: number; cacheWrite: number } {
  if (usage.cacheRead === undefined && usage.cacheWrite === undefined) {
    return { cacheRead: usage.cache, cacheWrite: 0 };
  }
  return { cacheRead: usage.cacheRead ?? 0, cacheWrite: usage.cacheWrite ?? 0 };
}

/**
 * The headline count: tokens the model freshly processed (input, output, and
 * cache writes). Cache reads are excluded; they dominate a long agent run's
 * total yet cost a tenth of input, so including them makes every turn read huge.
 */
export function freshTokens(usage: TokenUsage): number {
  return usage.total - splitCache(usage).cacheRead;
}

function buildTokenUsage(
  counts: { input: number; output: number; cacheRead: number; cacheWrite: number },
  source?: string,
): TokenUsage | undefined {
  const cache = counts.cacheRead + counts.cacheWrite;
  if (counts.input === 0 && counts.output === 0 && cache === 0) return undefined;
  return {
    input: counts.input,
    output: counts.output,
    cache,
    cacheRead: counts.cacheRead,
    cacheWrite: counts.cacheWrite,
    total: counts.input + counts.output + cache,
    ...(source ? { source } : {}),
  };
}

export function extractTokenUsageFromJsonl(text: string, source?: string): TokenUsage | undefined {
  const values: TokenUsage[] = [];
  // Claude repeats one API message's usage on every content-block event, all
  // sharing message.id. Without a terminal result (crash, kill) the per-message
  // usage is all there is, so keep one entry per message.
  const claudeMessages = new Map<string, TokenUsage>();
  let terminalClaudeUsage: TokenUsage | undefined;
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let event: unknown;
    try {
      event = JSON.parse(trimmed);
    } catch {
      continue;
    }
    const eventRecord = asRecord(event);
    if (source === "claude" && eventRecord?.type === "result") {
      terminalClaudeUsage = normalizeTokenUsage(eventRecord.usage, source) ?? terminalClaudeUsage;
    }
    if (source === "pi" && eventRecord?.type !== "message_end") continue;
    const usage = usageFromEvent(event, source);
    if (!usage) continue;
    const messageId = source === "claude" ? asRecord(eventRecord?.message)?.id : undefined;
    if (typeof messageId === "string" && messageId) claudeMessages.set(messageId, usage);
    else values.push(usage);
  }
  if (terminalClaudeUsage) return terminalClaudeUsage;
  const merged = mergeTokenUsage([...values, ...claudeMessages.values()]);
  return merged ? { ...merged, ...(source ? { source } : {}) } : undefined;
}

function usageFromEvent(event: unknown, source?: string): TokenUsage | undefined {
  const record = asRecord(event);
  if (!record) return undefined;
  return (
    normalizeTokenUsage(record.usage, source) ??
    normalizeTokenUsage(asRecord(record.message)?.usage, source) ??
    normalizeTokenUsage(asRecord(record.response)?.usage, source) ??
    normalizeTokenUsage(asRecord(record.result)?.usage, source)
  );
}

function sumNumericFields(record: Record<string, unknown>, keys: string[]): number {
  let total = 0;
  for (const key of keys) total += numeric(record[key]);
  return total;
}

function sumNestedNumericFields(record: Record<string, unknown>, key: string, fields: string[]): number {
  const nested = asRecord(record[key]);
  return nested ? sumNumericFields(nested, fields) : 0;
}

function numeric(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
