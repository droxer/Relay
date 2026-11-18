import { asRecord } from "./shell.js";

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

type ContentKind = "text" | "thinking";
type ContentBlock = { kind: ContentKind; id: number; index: number; text: string };

export type PiStreamEvent =
  | (ContentBlock & { delta: string })
  | { kind: "tool"; id?: string; name: string; input: unknown }
  | { kind: "error"; message: string; legacy?: true }
  | { kind: "snapshot"; blocks: readonly ContentBlock[] }
  | { kind: "retry" }
  | { kind: "boundary" };

/** Reconcile Pi's streamed blocks with the snapshots repeated at message and turn end. */
export class PiStreamDecoder {
  private readonly blocks = new Map<string, ContentBlock>();
  private nextBlockId = 0;
  private sawMessageContent = false;
  private lastError?: string;
  failure?: string;

  apply(event: Record<string, unknown>): PiStreamEvent[] {
    const message = asRecord(event.message ?? event);
    switch (event.type) {
      case "turn_start":
      case "message_start":
        if (event.type === "message_start" && message.role !== "assistant") return [];
        this.blocks.clear();
        this.sawMessageContent = false;
        this.lastError = undefined;
        return [{ kind: "boundary" }];
      case "message_update":
        if (event.message !== undefined && message.role !== "assistant") return [];
        return this.update(asRecord(event.assistantMessageEvent), message);
      case "tool_execution_start":
        return this.tool(event.toolCallId, event.toolName, event.args);
      case "message_end":
      case "turn_end": {
        if (message.role !== "assistant") return [];
        // turn_end echoes message_end, and older logs may omit blocks from the echo.
        const out = event.type === "turn_end" && this.sawMessageContent ? [] : this.snapshot(message);
        if (event.type === "message_end" && this.blocks.size > 0 && this.hasContent(message)) {
          this.sawMessageContent = true;
        }
        out.push(this.completedSnapshot());
        const detail = message.errorMessage ?? event.errorMessage;
        if (detail || message.stopReason === "error") {
          out.push(...this.error(detail));
        } else if (typeof message.stopReason === "string") {
          this.failure = undefined;
          this.lastError = undefined;
        }
        return out;
      }
      case "agent_end":
        return event.willRetry === true ? this.retry() : [];
      case "auto_retry_start":
        return this.retry();
      case "auto_retry_end":
        return event.success === false ? this.error(event.finalError) : [];
      case "error":
        return this.error(event.message, true);
      case "message":
      case "assistant_message": {
        if (message.role && message.role !== "assistant") return [];
        const out = [...this.snapshot(message), this.completedSnapshot()];
        this.blocks.clear();
        return out;
      }
      default:
        return [];
    }
  }

  private update(update: Record<string, unknown>, message: Record<string, unknown>): PiStreamEvent[] {
    const index = typeof update.contentIndex === "number" ? update.contentIndex : 0;
    switch (update.type) {
      case "text_delta":
      case "thinking_delta":
        return this.content(update.type === "text_delta" ? "text" : "thinking", index, update.delta, true);
      case "text_end":
      case "thinking_end":
        return this.content(update.type === "text_end" ? "text" : "thinking", index, update.content);
      case "done":
        return [...this.snapshot(asRecord(update.message)), this.completedSnapshot()];
      case "toolcall_end": {
        const call = asRecord(update.toolCall);
        const tool = this.tool(call.id, call.name, call.arguments ?? call.args);
        // Older versions attach the message so text missing from the deltas
        // can still be read before the tool row.
        return tool.length > 0 ? [...this.snapshot(message), ...tool] : [];
      }
      default:
        return [];
    }
  }

  private snapshot(message: Record<string, unknown>): PiStreamEvent[] {
    if (typeof message.text === "string" || typeof message.content === "string") {
      return this.content("text", 0, message.text ?? message.content);
    }
    if (!Array.isArray(message.content)) return [];
    return message.content.flatMap((item, index) => {
      const block = asRecord(item);
      return block.type === "thinking"
        ? this.content("thinking", index, block.thinking)
        : this.content("text", index, block.text ?? block.content);
    });
  }

  private hasContent(message: Record<string, unknown>): boolean {
    return Boolean(message.text || (Array.isArray(message.content) ? message.content.length : message.content));
  }

  private completedSnapshot(): PiStreamEvent {
    return { kind: "snapshot", blocks: [...this.blocks.values()].sort((left, right) => left.index - right.index) };
  }

  private content(kind: ContentKind, index: number, value: unknown, append = false): PiStreamEvent[] {
    if (typeof value !== "string" || !value) return [];
    const key = `${kind}:${index}`;
    const previous = this.blocks.get(key);
    const before = previous?.text ?? "";
    const text = append ? before + value : value;
    if (text === before) return [];
    const block = { kind, id: previous?.id ?? this.nextBlockId++, index, text };
    this.blocks.set(key, block);
    // A replacement has no append-only delta. The terminal can reprint it
    // in order once the completed snapshot arrives.
    const delta = append ? value : text.startsWith(before) ? text.slice(before.length) : "";
    return [{ ...block, delta }];
  }

  private tool(id: unknown, name: unknown, input: unknown): PiStreamEvent[] {
    return typeof name === "string" ? [{ kind: "tool", name, input, id: typeof id === "string" ? id : undefined }] : [];
  }

  private error(detail: unknown, legacy?: true): PiStreamEvent[] {
    const message = typeof detail === "string" && detail ? detail : "unknown error";
    this.failure = `Pi error: ${message}`;
    if (this.lastError === message) return [];
    this.lastError = message;
    return [{ kind: "error", message, legacy }];
  }

  private retry(): PiStreamEvent[] {
    // The same error may be reported again when the retry ends.
    this.lastError = undefined;
    return [{ kind: "retry" }];
  }
}
