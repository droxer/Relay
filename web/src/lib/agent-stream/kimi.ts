import { asRecord, textFromContent, toolInput, toolTarget } from "./builders.ts";
import { streamRecords, stripAnsi } from "./records.ts";
import type { AgentSegment } from "./segments.ts";

export function parseKimi(raw: string): AgentSegment[] {
  const out: AgentSegment[] = [];
  for (const record of streamRecords(raw)) {
    if (record.kind === "text") {
      const text = stripAnsi(record.text).trim();
      if (text) out.push({ kind: "text", text });
      continue;
    }
    const event = record.value;
    if (event.type === "error") {
      out.push({ kind: "status", tone: "bad", text: `Kimi error: ${String(event.message ?? "unknown error")}` });
      continue;
    }

    const message = asRecord(event.message ?? event);
    const role = message.role ?? event.role;
    if (role !== undefined && role !== "assistant") continue;

    const text = textFromContent(message).trimEnd();
    if (text) out.push({ kind: "text", text });

    const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
    for (const call of toolCalls) {
      const callRecord = asRecord(call);
      const fn = asRecord(callRecord.function);
      const target = toolTarget(toolInput(fn.arguments ?? callRecord.arguments));
      out.push({
        kind: "tool",
        name: String(fn.name ?? callRecord.name ?? "tool"),
        ...(target ? { target } : {}),
      });
    }
  }
  return out;
}
