import { formatOpenCodeToolError } from "relay-core/opencode-errors";
import { asRecord, oneLineTarget, toolInput, toolTarget, upsertSegmentById } from "./builders.ts";
import { streamRecords, stripAnsi } from "./records.ts";
import type { AgentSegment, ToolSegment } from "./segments.ts";

// Native runs emit whole parts; Relay's ACP adapter marks append-only text
// chunks with `delta: true`. Keep one growing segment across these records.
export function parseOpenCode(raw: string, displayName?: string): AgentSegment[] {
  return new OpenCodeStreamParser(displayName).append(raw);
}

export class OpenCodeStreamParser {
  private segments: AgentSegment[] = [];
  private activeDelta?: { index: number; kind: "text" | "thinking"; messageId: unknown };
  private toolSegmentById = new Map<string, number>();
  private failedTools = new Set<string>();

  constructor(private readonly displayName = "OpenCode") {}

  // Preview the unfinished suffix without committing it: the next transport
  // chunk may extend a plain line or complete a fragmented JSON record.
  preview(raw: string): AgentSegment[] {
    if (!raw.trim()) return this.segments;
    const parser = new OpenCodeStreamParser(this.displayName);
    parser.segments = this.segments;
    parser.activeDelta = this.activeDelta;
    parser.toolSegmentById = new Map(this.toolSegmentById);
    parser.failedTools = new Set(this.failedTools);
    return parser.append(raw);
  }

  append(raw: string): AgentSegment[] {
    const out = [...this.segments];
    for (const record of streamRecords(raw)) {
      if (record.kind === "text") {
        const text = stripAnsi(record.text).trim();
        if (text) out.push({ kind: "text", text });
        this.activeDelta = undefined;
        continue;
      }

      const event = record.value;
      const part = asRecord(event.part);
      if (event.type === "text" || event.type === "reasoning") {
        this.appendContent(out, event.type === "text" ? "text" : "thinking", part, event.delta === true);
      } else if (event.type === "tool_use") {
        this.appendTool(out, part);
      } else if (event.type === "error") {
        this.activeDelta = undefined;
        const error = asRecord(event.error);
        out.push({ kind: "status", tone: "bad", text: `${this.displayName} error: ${String(error.message ?? "unknown error")}` });
      }
    }
    this.segments = out;
    return out;
  }

  private appendContent(
    out: AgentSegment[], kind: "text" | "thinking", part: Record<string, unknown>, delta: boolean,
  ): void {
    const text = typeof part.text === "string" ? part.text : "";
    if (!delta) {
      this.activeDelta = undefined;
      const content = kind === "text" ? text.replace(/^(?:[ \t]*\r?\n)+/, "").trimEnd() : text.trim();
      if (content) out.push({ kind, text: content });
      return;
    }
    if (!text) return;
    const active = this.activeDelta;
    const messageId = part.messageID;
    if (active?.kind === kind && active.messageId === messageId) {
      const previous = out[active.index];
      if (previous?.kind === kind) out[active.index] = { kind, text: previous.text + text };
    } else {
      this.activeDelta = { index: out.length, kind, messageId };
      out.push({ kind, text });
    }
  }

  private appendTool(out: AgentSegment[], part: Record<string, unknown>): void {
    const state = asRecord(part.state);
    const callID = part.callID ?? part.id;
    const id = typeof callID === "string" ? callID : undefined;
    if (state.status !== "completed" && state.status !== "error"
      && !(id && (state.status === "pending" || state.status === "running"))) return;
    const index = id ? this.toolSegmentById.get(id) : undefined;
    const previous = index === undefined ? undefined : out[index] as ToolSegment;
    const name = typeof part.tool === "string" ? part.tool : previous?.name ?? "tool";
    const target = toolTarget(toolInput(state.input))
      ?? previous?.target
      ?? (state.title === name ? undefined : oneLineTarget(state.title));
    const tool: ToolSegment = { kind: "tool", name, ...(target ? { target } : {}) };
    if (index === undefined) this.activeDelta = undefined;
    if (!previous || previous.name !== name || previous.target !== target) {
      upsertSegmentById(out, this.toolSegmentById, id, tool);
    }
    if (state.status !== "error" || (id && this.failedTools.has(id))) return;
    // Older Relay ACP adapters reported a failed tool's message as `output`.
    const error = [state.error, state.output].find((value) => typeof value === "string" && value.trim());
    if (typeof error !== "string") return;
    this.activeDelta = undefined;
    if (id) this.failedTools.add(id);
    out.push({ kind: "status", scope: "tool", ...formatOpenCodeToolError(name, error) });
  }
}
