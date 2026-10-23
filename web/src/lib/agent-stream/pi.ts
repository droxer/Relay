import {
  asRecord,
  TextBuffer,
  textFromContent,
  toolInput,
  toolTarget,
  upsertSegmentById,
} from "./builders.ts";
import { streamRecords, stripAnsi } from "./records.ts";
import type { AgentSegment } from "./segments.ts";

export function parsePi(raw: string): AgentSegment[] {
  const out: AgentSegment[] = [];
  const textBuffer = new TextBuffer();
  const thinkingBuffer = new TextBuffer();
  let sawAssistantTextInTurn = false;
  let sawAssistantThinkingInTurn = false;
  const toolSegmentById = new Map<string, number>();
  for (const record of streamRecords(raw)) {
    if (record.kind === "text") {
      const text = stripAnsi(record.text).trim();
      if (text) out.push({ kind: "text", text });
      continue;
    }
    const event = record.value;
    if (event.type === "turn_start") {
      textBuffer.flush(out, "text");
      thinkingBuffer.flush(out, "thinking");
      sawAssistantTextInTurn = false;
      sawAssistantThinkingInTurn = false;
      toolSegmentById.clear();
      continue;
    }
    const delta = piAssistantDelta(event, "text_delta");
    if (delta.trim()) {
      sawAssistantTextInTurn = true;
      thinkingBuffer.flush(out, "thinking");
      textBuffer.push(delta);
      continue;
    }
    const thinkingDelta = piAssistantDelta(event, "thinking_delta");
    if (thinkingDelta.trim()) {
      textBuffer.flush(out, "text");
      sawAssistantThinkingInTurn = true;
      thinkingBuffer.push(thinkingDelta);
      continue;
    }
    const endedText = piAssistantEndedContent(event, "text_end").trimEnd();
    if (endedText) {
      thinkingBuffer.flush(out, "thinking");
      textBuffer.flush(out, "text");
      if (!sawAssistantTextInTurn) out.push({ kind: "text", text: endedText });
      sawAssistantTextInTurn = true;
      continue;
    }
    const endedThinking = piAssistantEndedContent(event, "thinking_end").trimEnd();
    if (endedThinking) {
      textBuffer.flush(out, "text");
      thinkingBuffer.flush(out, "thinking");
      if (!sawAssistantThinkingInTurn) out.push({ kind: "thinking", text: endedThinking });
      sawAssistantThinkingInTurn = true;
      continue;
    }
    const tool = piTool(event);
    if (tool) {
      const streamedText = textBuffer.flush(out, "text");
      if (streamedText) sawAssistantTextInTurn = true;
      thinkingBuffer.flush(out, "thinking");
      if (!sawAssistantTextInTurn) {
        const accumulatedText = piAssistantText(event).trimEnd();
        if (accumulatedText) {
          out.push({ kind: "text", text: accumulatedText });
          sawAssistantTextInTurn = true;
        }
      }
      const segment: AgentSegment = {
        kind: "tool",
        name: tool.name,
        ...(tool.target ? { target: tool.target } : {}),
      };
      upsertSegmentById(out, toolSegmentById, tool.id, segment);
      continue;
    }
    // Pi hangs the accumulated assistant message off every `message_update`,
    // so that snapshot always restates what the streaming branches above own:
    // `text_start` carries the opening characters the deltas have not sent yet,
    // and the `toolcall_*` frames that follow a reply repeat it in full. Both
    // rendered as extra segments — a truncated one before the block streamed
    // and one more copy of the whole reply per trailing frame. Only the
    // non-streaming frame shapes may fall back to the snapshot. Tool frames
    // keep their own recovery above for replies that never streamed at all.
    const assistantText = event.type === "message_update" ? "" : piAssistantText(event).trimEnd();
    if (assistantText) {
      textBuffer.flush(out, "text");
      thinkingBuffer.flush(out, "thinking");
      // Gate on whether the turn has rendered text at all, matching the
      // `text_end` and tool branches above, rather than enumerating the
      // end-of-turn event types.
      if (sawAssistantTextInTurn) continue;
      sawAssistantTextInTurn = true;
      out.push({ kind: "text", text: assistantText });
      continue;
    }
    if (event.type === "error") {
      textBuffer.flush(out, "text");
      thinkingBuffer.flush(out, "thinking");
      out.push({ kind: "status", tone: "bad", text: String(event.message ?? "unknown error") });
      continue;
    }
    const status = piStatusSegment(event);
    if (status) {
      textBuffer.flush(out, "text");
      thinkingBuffer.flush(out, "thinking");
      out.push(status);
    }
  }
  textBuffer.flush(out, "text");
  thinkingBuffer.flush(out, "thinking");
  return out;
}

function piAssistantText(event: Record<string, unknown>): string {
  const message = asRecord(event.message ?? event);
  if (event.type !== "message" && event.type !== "assistant_message" && message.role !== "assistant") return "";
  if (message.role && message.role !== "assistant") return "";
  return textFromContent(message);
}

// The assistant-message event a `message_update` carries, or an empty record
// for anything else. Pi only streams assistant messages, and newer Pi builds
// (the BoxLite guest's, for one) leave the accumulated `message` snapshot off
// every update — so a missing snapshot still means the assistant is speaking;
// only a snapshot that names another role rules the frame out.
function piAssistantUpdate(event: Record<string, unknown>): Record<string, unknown> {
  if (event.type !== "message_update") return {};
  if (event.message !== undefined && asRecord(event.message).role !== "assistant") return {};
  return asRecord(event.assistantMessageEvent);
}

function piAssistantDelta(event: Record<string, unknown>, type: "text_delta" | "thinking_delta"): string {
  const assistantEvent = piAssistantUpdate(event);
  if (assistantEvent.type !== type) return "";
  return typeof assistantEvent.delta === "string" ? assistantEvent.delta : "";
}

function piAssistantEndedContent(event: Record<string, unknown>, type: "text_end" | "thinking_end"): string {
  const assistantEvent = piAssistantUpdate(event);
  if (assistantEvent.type === type && typeof assistantEvent.content === "string") return assistantEvent.content;
  if (assistantEvent.type === "done" && type === "text_end") {
    return textFromContent(asRecord(assistantEvent.message));
  }
  return "";
}

function piTool(event: Record<string, unknown>): { id?: string; name: string; target?: string } | null {
  if (event.type === "tool_execution_start" && typeof event.toolName === "string") {
    return {
      id: typeof event.toolCallId === "string" ? event.toolCallId : undefined,
      name: event.toolName,
      target: toolTarget(toolInput(event.args)),
    };
  }
  const assistantEvent = piAssistantUpdate(event);
  if (assistantEvent.type !== "toolcall_end") return null;
  const toolCall = asRecord(assistantEvent.toolCall);
  if (typeof toolCall.name !== "string") return null;
  return {
    id: typeof toolCall.id === "string" ? toolCall.id : undefined,
    name: toolCall.name,
    target: toolTarget(toolInput(toolCall.arguments ?? toolCall.args)),
  };
}

function piStatusSegment(event: Record<string, unknown>): AgentSegment | null {
  if (event.type === "auto_retry_end" && event.success === false) {
    return { kind: "status", tone: "bad", text: `Pi error: ${String(event.finalError ?? "unknown error")}` };
  }
  if (event.type !== "message_end" && event.type !== "turn_end") return null;
  const message = asRecord(event.message ?? event);
  if (message.role !== "assistant") return null;
  const errorMessage = message.errorMessage ?? event.errorMessage;
  if (errorMessage || message.stopReason === "error") {
    return { kind: "status", tone: "bad", text: `Pi error: ${String(errorMessage ?? "unknown error")}` };
  }
  return null;
}
