import { asRecord, oneLineTarget, toolInput, toolTarget } from "./builders.ts";
import { streamRecords, stripAnsi } from "./records.ts";
import type { AgentSegment } from "./segments.ts";

// Native runs emit whole parts; Relay's ACP adapter marks append-only text
// chunks with `delta: true`. Keep one growing segment across these records.
export function parseOpenCode(raw: string): AgentSegment[] {
  return new OpenCodeStreamParser().append(raw);
}

export class OpenCodeStreamParser {
  private segments: AgentSegment[] = [];
  private textIndex = -1;

  // Preview the unfinished suffix without committing it: the next transport
  // chunk may extend a plain line or complete a fragmented JSON record.
  preview(raw: string): AgentSegment[] {
    if (!raw) return this.segments;
    const parser = new OpenCodeStreamParser();
    parser.segments = this.segments;
    parser.textIndex = this.textIndex;
    return parser.append(raw);
  }

  append(raw: string): AgentSegment[] {
    const out = [...this.segments];
    for (const record of streamRecords(raw)) {
      if (record.kind === "text") {
        const text = stripAnsi(record.text).trim();
        if (text) out.push({ kind: "text", text });
        this.textIndex = -1;
        continue;
      }

      const event = record.value;
      const part = asRecord(event.part);
      if (event.type === "text" && event.delta === true) {
        const text = typeof part.text === "string" ? part.text : "";
        if (!text) continue;
        const previous = out[this.textIndex];
        if (previous?.kind === "text") {
          out[this.textIndex] = { kind: "text", text: previous.text + text };
        } else {
          this.textIndex = out.length;
          out.push({ kind: "text", text });
        }
        continue;
      }
      if (event.type === "text" || event.type === "reasoning") {
        this.textIndex = -1;
        const text = typeof part.text === "string" ? part.text.trim() : "";
        if (text) out.push({ kind: event.type === "text" ? "text" : "thinking", text });
      } else if (event.type === "tool_use") {
        this.textIndex = -1;
        out.push(...openCodeTool(part));
      } else if (event.type === "error") {
        this.textIndex = -1;
        const error = asRecord(event.error);
        out.push({ kind: "status", tone: "bad", text: `OpenCode error: ${String(error.message ?? "unknown error")}` });
      }
    }
    this.segments = out;
    return out;
  }
}

function openCodeTool(part: Record<string, unknown>): AgentSegment[] {
  const state = asRecord(part.state);
  if (state.status !== "completed" && state.status !== "error") return [];
  const name = typeof part.tool === "string" ? part.tool : "tool";
  // OpenCode 2.x sets a completed tool's title to its own name, which says
  // nothing the tool line does not already show.
  const target = toolTarget(toolInput(state.input))
    ?? (state.title === name ? undefined : oneLineTarget(state.title));
  const segments: AgentSegment[] = [{ kind: "tool", name, ...(target ? { target } : {}) }];
  if (state.status === "error") {
    // Older Relay ACP adapters reported a failed tool's message as `output`.
    const error = [state.error, state.output].find((value) => typeof value === "string" && value.trim());
    if (typeof error === "string") segments.push({ kind: "status", tone: "bad", text: error.trim() });
  }
  return segments;
}
