/** One Pi JSONL frame, or a line from an older Pi's plain print mode. */
export type PiOutputRecord =
  | { kind: "json"; value: Record<string, unknown> }
  | { kind: "text"; text: string };

/**
 * Recover at newline boundaries, never at braces inside a clipped JSON string.
 * Completed-log tail caps can remove the opening of the first frame. Only
 * malformed lines with JSON suffix syntax are discarded; ordinary diagnostics
 * mentioning protocol keys or punctuation remain visible.
 */
export function parsePiOutputLine(line: string, complete = true): PiOutputRecord | null {
  const text = line.trim();
  if (!text) return null;
  try {
    const value: unknown = JSON.parse(text);
    if (value && typeof value === "object" && !Array.isArray(value)) {
      return { kind: "json", value: value as Record<string, unknown> };
    }
  } catch {
    // Still arriving, or the retained log starts inside this frame.
  }
  if (text.startsWith("{")) return null;

  const fieldSuffix = /(?:^"?|,\s*")[^"\n]*"\s*:[\s\S]*[}\]]\s*(?:,\s*"message"\s*:)?\s*$/;
  if (fieldSuffix.test(text)) return null;
  if (/^[}\],:]+$/.test(text) || /"[}\]]+\s*$/.test(text)) return null;
  if (/^:?(?:[a-z\d_.-]+)?[}\]]+\s*$/i.test(text)) return null;

  // Do not flash JSON escapes from a clipped string before its metadata and
  // newline arrive. Framed assistant text was decoded above and is preserved.
  if (!complete && /\\(?:["\\/bfnrtu]|$)|"\s*[,}\]]/.test(text)) return null;
  return { kind: "text", text };
}
