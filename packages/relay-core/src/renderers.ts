import { ansi, color, status } from "./format.js";
import { asRecord, parseJsonObject } from "./shell.js";

const TEXT_MARK = "●";
const THINK_MARK = "○";
const TOOL_MARK = "⏺";
const CONTINUATION_INDENT = "  ";

// Strip ANSI escape sequences and disallowed control chars from untrusted
// agent output (e.g. when a streaming JSONL line fails to parse and falls
// back to plain text). We keep \t (0x09) and \n (0x0a).
export function sanitizeUntrustedText(value: string): string {
  let result = "";
  let i = 0;
  while (i < value.length) {
    const code = value.charCodeAt(i);
    if (code === 0x1b) {
      i += 1;
      const next = value.charCodeAt(i);
      if (next === 0x5b || next === 0x5d) {
        i += 1;
        while (i < value.length) {
          const c = value.charCodeAt(i);
          if ((c >= 0x40 && c <= 0x7e) || c === 0x07) { i += 1; break; }
          i += 1;
        }
      } else if (Number.isFinite(next)) {
        i += 1;
      }
      continue;
    }
    if (code === 0x09 || code === 0x0a || (code >= 0x20 && code !== 0x7f)) {
      result += value[i];
    }
    i += 1;
  }
  return result;
}

export class BlockStreamRenderer {
  private atLineStart = true;
  private blockStarted = false;

  constructor(
    private readonly marker: string,
    private readonly markerColor: string,
    private readonly bodyStyles: readonly string[] = [],
  ) {}

  resetBlock(): void {
    this.blockStarted = false;
    this.atLineStart = true;
  }

  feed(chunk: string): string {
    let output = "";
    for (const char of chunk) {
      if (char === "\r") continue;
      if (this.atLineStart && char !== "\n") {
        output += this.blockStarted
          ? CONTINUATION_INDENT
          : `${color(this.marker, this.markerColor)} `;
        this.blockStarted = true;
        if (this.bodyStyles.length > 0) output += this.bodyStyles.join("");
        this.atLineStart = false;
      }
      if (char === "\n") {
        if (this.bodyStyles.length > 0) output += ansi.reset;
        output += "\n";
        this.atLineStart = true;
      } else {
        output += char;
      }
    }
    return output;
  }
}

export class PlainTextStreamRenderer extends BlockStreamRenderer {
  constructor(_name: string, accent: string) {
    super(TEXT_MARK, accent);
  }
}

export class PiStreamRenderer {
  private readonly text = new BlockStreamRenderer(TEXT_MARK, ansi.live);
  private readonly plain = new PlainTextStreamRenderer("Pi", ansi.live);
  private readonly lines = new JsonLineRenderer((line) => this.formatLine(line));
  private sawAssistantTextInTurn = false;

  feed(chunk: string): string {
    return this.lines.feed(chunk);
  }

  private formatLine(line: string): string {
    const event = parseJsonObject(line);
    if (!event) return this.plain.feed(`${sanitizeUntrustedText(line)}\n`);

    if (event.type === "turn_start") {
      this.sawAssistantTextInTurn = false;
      return "";
    }
    if (event.type === "message_start" && asRecord(event.message).role === "assistant") {
      this.text.resetBlock();
      return "";
    }

    const delta = piAssistantTextDelta(event);
    if (delta.trim()) {
      this.sawAssistantTextInTurn = true;
      return this.text.feed(sanitizeUntrustedText(delta));
    }

    // text_end repeats the streamed deltas' full content; render it only when
    // no deltas were seen (non-streaming responses), never as a replay.
    const endedText = piAssistantEndedText(event);
    if (endedText.trim()) {
      if (this.sawAssistantTextInTurn) return "";
      this.sawAssistantTextInTurn = true;
      this.text.resetBlock();
      return this.text.feed(`${sanitizeUntrustedText(endedText.trim())}\n`);
    }
    // Remaining message_update subtypes (thinking, tool calls) carry the
    // accumulated message; extracting text from them would duplicate output.
    if (event.type === "message_update") return "";

    const text = piAssistantText(event);
    if (text.trim()) {
      if (this.sawAssistantTextInTurn && isPiAssistantTerminalEvent(event)) return "";
      this.sawAssistantTextInTurn = true;
      this.text.resetBlock();
      return this.text.feed(`${text.trim()}\n`);
    }

    if (event.type === "error") {
      return `\n${status("error", `Pi error: ${String(event.message ?? "unknown error")}`)}\n`;
    }
    const piStatus = piStatusMessage(event);
    if (piStatus) {
      return `\n${piStatus}\n`;
    }
    return "";
  }
}

export class StderrLineRenderer {
  private buffer = "";

  feed(chunk: string): string {
    this.buffer += chunk;
    const output: string[] = [];
    while (this.buffer.includes("\n")) {
      const index = this.buffer.indexOf("\n");
      const line = this.buffer.slice(0, index).trim();
      this.buffer = this.buffer.slice(index + 1);
      const formatted = this.formatLine(line);
      if (formatted) output.push(formatted);
    }
    return output.join("");
  }

  private formatLine(line: string): string {
    if (!line) return "";
    if (line.includes("seccomp not available")) return "";
    if (isCodexStdinNotice(line)) return "";
    if (isCodexModelsCacheWarning(line)) return "";
    if (isCodexLegacyMultiAgentFallback(line)) return "";
    if (isKimiResumeNotice(line)) return "";
    if (isClaudeConnectorNotice(line)) return "";
    return `${status("warn", line)}\n`;
  }
}

function isCodexStdinNotice(line: string): boolean {
  return /^Reading additional input from stdin(?:\.{1,3}|…)?$/.test(line);
}

// Codex ignores an incompatible cache and refreshes model metadata. Different
// installed Codex surfaces can briefly write different cache schemas, so keep
// this recoverable local-cache detail out of the agent transcript.
function isCodexModelsCacheWarning(line: string): boolean {
  return /codex_models_manager::cache: failed to load models cache: missing field [`']base_instructions[`']/.test(line);
}

// Codex 0.138 can log a failed v1 lookup before its enabled v2 collaboration
// handler executes the same call successfully. Keep the raw stderr in the run
// log, but do not present this internal fallback as a user-facing warning.
function isCodexLegacyMultiAgentFallback(line: string): boolean {
  return /unsupported call:\s*multi_agent_v1__/.test(line);
}

// Kimi prints a "To resume this session: kimi -r <id>" footer to stderr after a
// non-interactive run; it is an interactive-resume hint, not a warning.
function isKimiResumeNotice(line: string): boolean {
  return /resume this session\s*:/i.test(line) || /\bkimi\s+-(?:r|S|-session)\b/.test(line);
}

// Claude prints a claude.ai connectors notice when ANTHROPIC_API_KEY or another
// auth source takes precedence over the claude.ai login. Relay provisions auth
// deliberately, so the notice is informational, not a run warning.
function isClaudeConnectorNotice(line: string): boolean {
  return /claude\.ai connectors are disabled/.test(line)
    || /Unset it to load your organization's connectors/.test(line);
}

export class JsonLineRenderer {
  private buffer = "";

  constructor(private readonly formatLine: (line: string) => string) {}

  feed(chunk: string): string {
    this.buffer += chunk;
    const output: string[] = [];
    while (this.buffer.includes("\n")) {
      const index = this.buffer.indexOf("\n");
      const line = this.buffer.slice(0, index).trim();
      this.buffer = this.buffer.slice(index + 1);
      if (line) output.push(this.formatLine(line));
    }
    return output.join("");
  }
}

// A tool call is supporting detail beside the agent's words, so it reads dim.
function toolLine(label: string, target: string): string {
  return `\n${color(TOOL_MARK, ansi.dim)} ${color(label, ansi.dim)} ${color(target, ansi.dim)}\n`;
}

export class ClaudeStreamRenderer {
  private readonly text = new BlockStreamRenderer(TEXT_MARK, ansi.live);
  private readonly thinking = new BlockStreamRenderer(THINK_MARK, ansi.dim, [ansi.dim, ansi.italic]);
  private readonly lines = new JsonLineRenderer((line) => this.formatLine(line));

  feed(chunk: string): string {
    return this.lines.feed(chunk);
  }

  private formatLine(line: string): string {
    const event = parseJsonObject(line);
    if (!event) {
      if (isClaudeConnectorNotice(line)) return "";
      return this.text.feed(`${sanitizeUntrustedText(line)}\n`);
    }

    if (event.type === "stream_event") {
      const streamEvent = asRecord(event.event);
      const delta = asRecord(streamEvent.delta);
      const contentBlock = asRecord(streamEvent.content_block);
      if (streamEvent.type === "content_block_start") {
        if (contentBlock.type === "tool_use") {
          this.text.resetBlock();
          this.thinking.resetBlock();
          return toolLine("tool", String(contentBlock.name ?? "unknown"));
        }
        if (contentBlock.type === "thinking") this.thinking.resetBlock();
        else this.text.resetBlock();
        return "";
      }
      if (streamEvent.type === "content_block_stop") {
        this.text.resetBlock();
        this.thinking.resetBlock();
        return "\n";
      }
      if (delta.type === "text_delta") return this.text.feed(String(delta.text ?? ""));
      if (delta.type === "thinking_delta") return this.thinking.feed(String(delta.thinking ?? ""));
      return "";
    }

    if (event.type === "assistant") {
      const message = asRecord(event.message);
      const content = Array.isArray(message.content) ? message.content : [];
      const output: string[] = [];
      for (const item of content) {
        const block = asRecord(item);
        if (block.type === "text") {
          const text = String(block.text ?? "").trim();
          if (text) {
            this.text.resetBlock();
            output.push(this.text.feed(`${text}\n`));
          }
        } else if (block.type === "tool_use") {
          output.push(toolLine("tool", String(block.name ?? "unknown")));
        }
      }
      return output.join("");
    }

    if (event.type === "result") {
      return event.is_error
        ? `\n${status("error", `Claude error: ${String(event.result ?? "unknown error")}`)}\n`
        : `\n${status("ok", "Claude finished.")}\n`;
    }
    if (event.type === "system" && event.subtype === "api_retry") {
      return `\n${status("warn", `Claude API retry ${String(event.attempt ?? "?")}/${String(event.max_retries ?? "?")}.`)}\n`;
    }
    return "";
  }
}

export class CodexStreamRenderer {
  private readonly text = new BlockStreamRenderer(TEXT_MARK, ansi.live);
  private readonly reasoning = new BlockStreamRenderer(THINK_MARK, ansi.dim, [ansi.dim, ansi.italic]);
  private readonly lines = new JsonLineRenderer((line) => this.formatLine(line));

  feed(chunk: string): string {
    return this.lines.feed(chunk);
  }

  private formatLine(line: string): string {
    const event = parseJsonObject(line);
    if (!event) return this.text.feed(`${sanitizeUntrustedText(line)}\n`);

    if (event.type === "turn.started") return `\n${status("info", "Codex started.")}\n`;
    if (event.type === "turn.completed") return `\n${status("ok", "Codex finished.")}\n`;
    if (event.type === "turn.failed") {
      const error = asRecord(event.error);
      return `\n${status("error", `Codex failed: ${codexErrorMessage(error.message, "turn failed")}`)}\n`;
    }
    if (event.type === "error") return `\n${status("error", `Codex error: ${codexErrorMessage(event.message, "unknown error")}`)}\n`;

    if (typeof event.type === "string" && event.type.startsWith("item.")) {
      const item = asRecord(event.item);
      if (item.type === "agent_message" && event.type === "item.completed") {
        const text = textFromContentRecord(item).trim();
        if (!text) return "";
        this.text.resetBlock();
        return `\n${this.text.feed(`${text}\n`)}`;
      }
      if (item.type === "reasoning" && event.type === "item.completed") {
        const text = textFromContentRecord(item).trim();
        if (!text) return "";
        this.reasoning.resetBlock();
        return `\n${this.reasoning.feed(`${text}\n`)}`;
      }
      if (item.type === "command_execution" && event.type === "item.started") {
        return toolLine("command", String(item.command ?? "command"));
      }
      if (item.type === "file_change" && event.type === "item.completed") {
        return `\n${status("info", "Codex changed files.")}\n`;
      }
    }
    if (event.type === "message" || event.type === "assistant_message") {
      const text = textFromContentRecord(event).trim();
      if (!text) return "";
      this.text.resetBlock();
      return `\n${this.text.feed(`${text}\n`)}`;
    }
    return "";
  }
}

/**
 * Renders Kimi's `--output-format stream-json` stream. Each stdout line is an
 * OpenAI-chat-style message object (`role` + `content`, with `tool_calls` on
 * assistant turns; tool results arrive as `role:"tool"` messages). Kimi keeps
 * thinking content and the "resuming session" notice out of stdout, so we only
 * surface assistant text and tool invocations and drop everything else. Lines
 * that fail to parse (e.g. text-mode leakage) fall back to sanitized plain text.
 */
export class KimiStreamRenderer {
  private readonly text = new BlockStreamRenderer(TEXT_MARK, ansi.live);
  private readonly plain = new PlainTextStreamRenderer("Kimi", ansi.live);
  private readonly lines = new JsonLineRenderer((line) => this.formatLine(line));

  feed(chunk: string): string {
    return this.lines.feed(chunk);
  }

  private formatLine(line: string): string {
    const event = parseJsonObject(line);
    if (!event) return this.plain.feed(`${sanitizeUntrustedText(line)}\n`);

    if (event.type === "error") {
      return `\n${status("error", `Kimi error: ${String(event.message ?? "unknown error")}`)}\n`;
    }

    // Accept both the bare message shape ({role,content,...}) and a wrapped
    // form ({type,message:{...}}) for forward compatibility.
    const message = asRecord(event.message ?? event);
    const role = message.role ?? event.role;
    // Require the assistant role rather than merely tolerating it. A record
    // with no role is not a turn — rendering its text/content field would put
    // stream bookkeeping on screen as if the agent had said it.
    if (role !== "assistant") return "";

    const output: string[] = [];
    const text = textFromContentRecord(message).trim();
    if (text) {
      this.text.resetBlock();
      output.push(`\n${this.text.feed(`${text}\n`)}`);
    }

    const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
    for (const call of toolCalls) {
      const record = asRecord(call);
      const fn = asRecord(record.function);
      const name = String(fn.name ?? record.name ?? "tool");
      output.push(toolLine("tool", name));
    }

    return output.join("");
  }
}

export function formatKimiJsonLine(line: string): string {
  return new KimiStreamRenderer().feed(`${line}\n`);
}

function textFromContentRecord(record: Record<string, unknown>): string {
  if (typeof record.text === "string") return record.text;
  if (typeof record.content === "string") return record.content;
  const content = record.content;
  if (!Array.isArray(content)) return "";
  return content
    .map((chunk) => {
      const chunkRecord = asRecord(chunk);
      if (typeof chunkRecord.text === "string") return chunkRecord.text;
      if (typeof chunkRecord.content === "string") return chunkRecord.content;
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

function piAssistantText(event: Record<string, unknown>): string {
  const message = asRecord(event.message ?? event);
  if (event.type !== "message" && event.type !== "assistant_message" && message.role !== "assistant") return "";
  if (message.role && message.role !== "assistant") return "";
  return textFromContentRecord(message);
}

// The assistant-message event a `message_update` carries. Pi only streams
// assistant messages, and newer builds leave the `message` snapshot off every
// update, so only a snapshot naming another role rules the frame out.
function piAssistantUpdate(event: Record<string, unknown>): Record<string, unknown> {
  if (event.type !== "message_update") return {};
  if (event.message !== undefined && asRecord(event.message).role !== "assistant") return {};
  return asRecord(event.assistantMessageEvent);
}

function piAssistantEndedText(event: Record<string, unknown>): string {
  const assistantEvent = piAssistantUpdate(event);
  if (assistantEvent.type !== "text_end") return "";
  return typeof assistantEvent.content === "string" ? assistantEvent.content : "";
}

function piAssistantTextDelta(event: Record<string, unknown>): string {
  const assistantEvent = piAssistantUpdate(event);
  if (assistantEvent.type !== "text_delta") return "";
  return typeof assistantEvent.delta === "string" ? assistantEvent.delta : "";
}

function piStatusMessage(event: Record<string, unknown>): string {
  if (event.type === "auto_retry_end" && event.success === false) {
    return status("error", `Pi error: ${String(event.finalError ?? "unknown error")}`);
  }
  if (event.type !== "message_end" && event.type !== "turn_end") return "";
  const message = asRecord(event.message ?? event);
  if (message.role !== "assistant") return "";
  const errorMessage = message.errorMessage ?? event.errorMessage;
  if (errorMessage || message.stopReason === "error") {
    return status("error", `Pi error: ${String(errorMessage ?? "unknown error")}`);
  }
  return "";
}

function isPiAssistantTerminalEvent(event: Record<string, unknown>): boolean {
  if (event.type !== "message_end" && event.type !== "turn_end") return false;
  const message = asRecord(event.message ?? event);
  return message.role === "assistant";
}

// Codex forwards an API failure's body verbatim as the message; name the
// error that body carries instead of printing the JSON envelope.
function codexErrorMessage(value: unknown, fallback: string): string {
  const message = typeof value === "string" && value ? value : fallback;
  const body = parseJsonObject(message.trim());
  if (!body) return message;
  const nested = asRecord(body.error).message ?? body.message;
  return typeof nested === "string" && nested ? nested : message;
}

export function formatClaudeJsonLine(line: string): string {
  return new ClaudeStreamRenderer().feed(`${line}\n`);
}

export function formatCodexJsonLine(line: string): string {
  return new CodexStreamRenderer().feed(`${line}\n`);
}

export function formatPiJsonLine(line: string): string {
  return new PiStreamRenderer().feed(`${line}\n`);
}
