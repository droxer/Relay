import { asRecord, oneLineTarget, toolInput, toolTarget } from "./builders.ts";
import { streamRecords, stripAnsi } from "./records.ts";
import type { AgentSegment } from "./segments.ts";

// Both `opencode run --format json` and the ACP adapter emit whole parts.
// Reuse the stream framer so an unfinished NDJSON record stays hidden until
// the next stdout chunk completes it.
export function parseOpenCode(raw: string): AgentSegment[] {
  const out: AgentSegment[] = [];
  for (const record of streamRecords(raw)) {
    if (record.kind === "text") {
      const text = stripAnsi(record.text).trim();
      if (text) out.push({ kind: "text", text });
      continue;
    }

    const event = record.value;
    const part = asRecord(event.part);
    if (event.type === "text" || event.type === "reasoning") {
      const text = typeof part.text === "string" ? part.text.trim() : "";
      if (text) out.push({ kind: event.type === "text" ? "text" : "thinking", text });
    } else if (event.type === "tool_use") {
      out.push(...openCodeTool(part));
    } else if (event.type === "error") {
      const error = asRecord(event.error);
      out.push({ kind: "status", tone: "bad", text: `OpenCode error: ${String(error.message ?? "unknown error")}` });
    }
  }
  return out;
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
