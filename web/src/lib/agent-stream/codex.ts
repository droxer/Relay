import { asRecord, textFromContent, toolInput, toolTarget, upsertSegmentById } from "./builders.ts";
import { streamRecords, stripAnsi } from "./records.ts";
import { type AgentSegment, narration, type ToolSegment } from "./segments.ts";

function codexToolSegment(item: Record<string, unknown>): ToolSegment | null {
  if (item.type === "mcp_tool_call") {
    const server = typeof item.server === "string" ? item.server : "mcp";
    const tool = typeof item.tool === "string" ? item.tool : String(item.name ?? "tool");
    return { kind: "tool", name: `${server}.${tool}`, target: toolTarget(toolInput(item.arguments ?? item.input)) };
  }
  if (item.type === "web_search") {
    return { kind: "tool", name: "web_search", target: toolTarget(item) };
  }
  if (item.type === "dynamic_tool_call" || item.type === "tool_call") {
    return {
      kind: "tool",
      name: String(item.tool ?? item.name ?? "tool"),
      target: toolTarget(toolInput(item.arguments ?? item.input)),
    };
  }
  if (
    typeof item.type === "string"
    && item.type.endsWith("_tool_call")
    && item.type !== "collab_tool_call"
    && item.type !== "collab_agent_tool_call"
  ) {
    return {
      kind: "tool",
      name: String(item.tool ?? item.name ?? item.type.slice(0, -"_tool_call".length)),
      target: toolTarget(toolInput(item.arguments ?? item.input)),
    };
  }
  return null;
}

export function parseCodex(raw: string): AgentSegment[] {
  const out: AgentSegment[] = [];
  const toolSegmentById = new Map<string, number>();
  const toolItemById = new Map<string, Record<string, unknown>>();
  const commandSegmentById = new Map<string, number>();
  for (const record of streamRecords(raw)) {
    if (record.kind === "text") {
      out.push({ kind: "raw", text: stripAnsi(record.text) });
      continue;
    }
    const event = record.value;
    if (event.type === "turn.started") {
      toolSegmentById.clear();
      toolItemById.clear();
      commandSegmentById.clear();
      out.push(narration("agent_stream.codex_started", undefined, "info"));
      continue;
    }
    if (event.type === "turn.completed") {
      out.push(narration("agent_stream.codex_finished", undefined, "good"));
      continue;
    }
    if (event.type === "turn.failed") {
      const error = asRecord(event.error);
      out.push(narration("agent_stream.codex_failed", { message: String(error.message ?? "turn failed") }, "bad"));
      continue;
    }
    if (event.type === "error") {
      out.push(narration("agent_stream.codex_error", { message: String(event.message ?? "unknown") }, "bad"));
      continue;
    }
    if (event.type === "agent_message") {
      const text = textFromContent(event).trimEnd();
      if (text) out.push({ kind: "text", text });
      continue;
    }
    if (typeof event.type === "string" && event.type.startsWith("item.")) {
      const item = asRecord(event.item);
      if (item.type === "agent_message" && event.type === "item.completed") {
        const text = textFromContent(item).trimEnd();
        if (text) out.push({ kind: "text", text });
        continue;
      }
      if (item.type === "reasoning" && event.type === "item.completed") {
        const text = textFromContent(item).trimEnd();
        if (text) out.push({ kind: "thinking", text });
        continue;
      }
      if (
        item.type === "command_execution"
        && (event.type === "item.started" || event.type === "item.completed")
      ) {
        const id = typeof item.id === "string" ? item.id : undefined;
        const existing = id ? commandSegmentById.get(id) : undefined;
        const previous = existing === undefined ? undefined : out[existing];
        let command = "command";
        if (typeof item.command === "string") command = item.command;
        else if (previous?.kind === "command") command = previous.command;
        upsertSegmentById(out, commandSegmentById, id, {
          kind: "command",
          command,
        });
        continue;
      }
      if (event.type === "item.started" || event.type === "item.completed") {
        const id = typeof item.id === "string" ? item.id : undefined;
        const previousItem = id ? toolItemById.get(id) : undefined;
        const mergedItem = previousItem ? { ...previousItem, ...item } : item;
        const tool = codexToolSegment(mergedItem);
        if (tool) {
          if (id) toolItemById.set(id, mergedItem);
          upsertSegmentById(out, toolSegmentById, id, tool);
          continue;
        }
      }
      if (item.type === "file_change" && event.type === "item.completed") {
        out.push(narration("agent_stream.codex_changed_files", undefined, "info"));
      }
      continue;
    }
    if (event.type === "message" || event.type === "assistant_message") {
      const text = textFromContent(event).trimEnd();
      if (text) out.push({ kind: "text", text });
    }
  }
  return out;
}
