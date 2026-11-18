import { ansi, color, status } from "./format.js";
import { asRecord, parseJsonObject } from "./shell.js";
import { formatOpenCodeToolError } from "./opencode-errors.js";
import { parsePiOutputLine, PiStreamDecoder, type PiStreamEvent } from "./pi-output.js";

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
  private readonly thinking = new BlockStreamRenderer(THINK_MARK, ansi.dim, [ansi.dim, ansi.italic]);
  private readonly plain = new PlainTextStreamRenderer("Pi", ansi.live);
  private readonly decoder = new PiStreamDecoder();
  private readonly lines = new JsonLineRenderer((line) => this.formatLine(line));
  private readonly shownTools = new Set<string>();
  private activeBlock?: { id: number; renderer: BlockStreamRenderer };
  private needsNewline = false;
  private lastContentIndex = -1;
  private needsSnapshot = false;

  feed(chunk: string): string {
    return this.lines.feed(chunk);
  }

  runFailure(): string | undefined {
    this.lines.feed("\n");
    return this.decoder.failure;
  }

  private formatLine(line: string): string {
    const record = parsePiOutputLine(sanitizeUntrustedText(line));
    if (!record) return "";
    if (record.kind === "text") return this.closeBlock() + this.plain.feed(`${record.text}\n`);
    if (record.value.type === "turn_start") this.shownTools.clear();
    return this.decoder.apply(record.value).map((event) => this.render(event)).join("");
  }

  private render(event: PiStreamEvent): string {
    switch (event.kind) {
      case "thinking":
      case "text": {
        if (!event.delta || event.index < this.lastContentIndex) {
          this.needsSnapshot = true;
        }
        if (this.needsSnapshot) return "";
        this.lastContentIndex = event.index;
        return this.renderBlock(event.id, event.kind, event.delta);
      }
      case "snapshot": {
        const boundary = this.closeBlock();
        const needsSnapshot = this.needsSnapshot;
        this.needsSnapshot = false;
        this.lastContentIndex = -1;
        if (!needsSnapshot) return boundary;
        // A streamed draft can already be in terminal scrollback. Print the
        // authoritative blocks together so the corrected reply reads in order.
        const reply = event.blocks.map((block) => this.renderBlock(block.id, block.kind, block.text)).join("");
        return `${boundary}\n${status("info", "Pi final reply")}\n${reply}${this.closeBlock()}`;
      }
      case "boundary":
        this.needsSnapshot = false;
        this.lastContentIndex = -1;
        return this.closeBlock();
      case "retry":
        return "";
      case "tool": {
        if (event.id && this.shownTools.has(event.id)) return "";
        if (event.id) this.shownTools.add(event.id);
        return this.closeBlock() + toolLine("tool", sanitizeUntrustedText(event.name));
      }
      case "error":
        return `${this.closeBlock()}\n${status("error", `Pi error: ${sanitizeUntrustedText(event.message)}`)}\n`;
    }
  }

  private renderBlock(id: number, kind: "text" | "thinking", value: string): string {
    const text = sanitizeUntrustedText(value);
    if (!text) return "";
    const renderer = kind === "text" ? this.text : this.thinking;
    let leading = "";
    if (id !== this.activeBlock?.id) {
      leading = this.closeBlock();
      renderer.resetBlock();
      this.activeBlock = { id, renderer };
    }
    this.needsNewline = !text.endsWith("\n");
    return leading + renderer.feed(text);
  }

  private closeBlock(): string {
    const newline = this.needsNewline ? this.activeBlock?.renderer.feed("\n") ?? "" : "";
    this.activeBlock = undefined;
    this.needsNewline = false;
    return newline;
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
 * Renders `opencode run --format json`, and the ACP adapter that prints the
 * same lines: one NDJSON event per line. A text part is the assistant's
 * words (`delta: true` appends an ACP chunk), a tool_use part a tool call with
 * its state, an error event a failed turn. Step bookkeeping stays off screen.
 */
export class OpenCodeStreamRenderer {
  private activeDelta?: { type: "text" | "reasoning"; messageId: unknown };
  private readonly text = new BlockStreamRenderer(TEXT_MARK, ansi.live);
  private readonly thinking = new BlockStreamRenderer(THINK_MARK, ansi.dim, [ansi.dim, ansi.italic]);
  private readonly plain = new PlainTextStreamRenderer("OpenCode", ansi.live);
  private readonly lines = new JsonLineRenderer((line) => this.formatLine(line));
  private readonly shownTools = new Set<string>();
  private readonly failedTools = new Set<string>();

  feed(chunk: string): string {
    return this.lines.feed(chunk);
  }

  private formatLine(line: string): string {
    const event = parseJsonObject(line);
    if (!event) return this.closeDelta() + this.plain.feed(`${sanitizeUntrustedText(line)}\n`);

    if (event.type === "error") {
      const error = asRecord(event.error);
      const message = sanitizeUntrustedText(String(error.message ?? "unknown error"));
      return `${this.closeDelta()}\n${status("error", `OpenCode error: ${message}`)}\n`;
    }
    const part = asRecord(event.part);
    if (event.type === "text" || event.type === "reasoning") {
      return this.renderContent(event.type, part, event.delta === true);
    }
    if (event.type === "tool_use") {
      return this.renderTool(part);
    }
    return "";
  }

  private renderContent(type: "text" | "reasoning", part: Record<string, unknown>, delta: boolean): string {
    const text = typeof part.text === "string" ? sanitizeUntrustedText(part.text) : "";
    const renderer = type === "text" ? this.text : this.thinking;
    if (delta && this.activeDelta?.type === type && this.activeDelta.messageId === part.messageID) {
      return renderer.feed(text);
    }
    const content = delta ? text : type === "text" ? text.replace(/^(?:[ \t]*\n)+/, "").trimEnd() : text.trim();
    if (!content) return delta ? "" : this.closeDelta();
    const boundary = this.closeDelta() || "\n";
    renderer.resetBlock();
    if (delta) this.activeDelta = { type, messageId: part.messageID };
    return boundary + renderer.feed(delta ? content : `${content}\n`);
  }

  private renderTool(part: Record<string, unknown>): string {
    const state = asRecord(part.state);
    const callID = part.callID ?? part.id;
    const id = typeof callID === "string" ? callID : undefined;
    if (state.status !== "completed" && state.status !== "error"
      && !(id && (state.status === "pending" || state.status === "running"))) return "";
    let rendered = "";
    if (!id || !this.shownTools.has(id)) {
      if (id) this.shownTools.add(id);
      const target = typeof state.title === "string" && state.title ? state.title : String(part.tool ?? "tool");
      rendered = this.closeDelta() + toolLine("tool", sanitizeUntrustedText(target));
    }
    if (state.status !== "error" || (id && this.failedTools.has(id))) return rendered;
    const error = [state.error, state.output].find((value) => typeof value === "string" && value.trim());
    if (typeof error !== "string") return rendered;
    if (id) this.failedTools.add(id);
    const message = formatOpenCodeToolError(String(part.tool ?? "tool"), error);
    return rendered + this.closeDelta() + `${status(message.tone === "warn" ? "warn" : "error", sanitizeUntrustedText(message.text))}\n`;
  }

  private closeDelta(): string {
    const active = this.activeDelta;
    this.activeDelta = undefined;
    if (!active) return "";
    return (active.type === "text" ? this.text : this.thinking).feed("\n");
  }
}

export function formatOpenCodeJsonLine(line: string): string {
  return new OpenCodeStreamRenderer().feed(`${line}\n`);
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
