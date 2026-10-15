const ANSI_PATTERN = /\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g;

export function stripAnsi(value: string): string {
  return value.replace(ANSI_PATTERN, "");
}

export function isCodexStdinNotice(line: string): boolean {
  return /^Reading additional input from stdin(?:\.{1,3}|…)?$/.test(line);
}

export function isCodexModelsCacheWarning(line: string): boolean {
  return /codex_models_manager::cache: failed to load models cache: missing field [`']base_instructions[`']/.test(line);
}

// Claude prints a claude.ai connectors notice when ANTHROPIC_API_KEY or another
// auth source takes precedence over the claude.ai login. Relay provisions auth
// deliberately, so the notice is informational, not a run warning.
export function isClaudeConnectorNotice(line: string): boolean {
  return /claude\.ai connectors are disabled/.test(line)
    || /Unset it to load your organization's connectors/.test(line);
}

export function safeParse(line: string): Record<string, unknown> | null {
  try {
    const value = JSON.parse(line) as unknown;
    return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function isLikelyProtocolFragment(text: string): boolean {
  return /"type"\s*:|"session_id"\s*:|stream_event|content_block_|parent_tool_use_id|uuid/.test(text)
    || /(?:tream_event|ream_event|eam_event|am_event|m_event)"\s*,\s*"event"\s*:/.test(text);
}

type StreamRecord =
  | { kind: "json"; value: Record<string, unknown>; end: number }
  | { kind: "text"; text: string; end: number };

export function streamRecords(raw: string): StreamRecord[] {
  const out: StreamRecord[] = [];
  let i = 0;

  while (i < raw.length) {
    const char = raw[i];
    if (/\s/.test(char)) {
      i += 1;
      continue;
    }

    if (char !== "{") {
      const nextJson = raw.indexOf("{", i);
      const end = nextJson === -1 ? raw.length : nextJson;
      const text = raw.slice(i, end).trim();
      if (text && !isLikelyProtocolFragment(text) && !isClaudeConnectorNotice(text)) out.push({ kind: "text", text, end });
      i = end;
      continue;
    }

    let depth = 0;
    let inString = false;
    let escaped = false;
    let end = -1;

    for (let j = i; j < raw.length; j += 1) {
      const c = raw[j];
      if (escaped) {
        escaped = false;
        continue;
      }
      if (c === "\\") {
        escaped = inString;
        continue;
      }
      if (c === "\"") {
        inString = !inString;
        continue;
      }
      if (inString) continue;
      if (c === "{") depth += 1;
      if (c === "}") {
        depth -= 1;
        if (depth === 0) {
          end = j + 1;
          break;
        }
      }
    }

    if (end === -1) {
      // Unterminated object: this is almost always a JSON frame still being
      // streamed in. Drop it rather than flashing the partial as raw text;
      // the next render reparses once the closing brace arrives.
      break;
    }

    const jsonText = raw.slice(i, end);
    const parsed = safeParse(jsonText);
    if (parsed) out.push({ kind: "json", value: parsed, end });
    else if (!isLikelyProtocolFragment(jsonText)) out.push({ kind: "text", text: stripAnsi(jsonText), end });
    i = end;
  }

  return out;
}
