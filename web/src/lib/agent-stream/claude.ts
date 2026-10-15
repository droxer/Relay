import { asRecord, sameRenderedText, TextBuffer, toolTarget, upsertSegmentById } from "./builders.ts";
import { streamRecords, stripAnsi } from "./records.ts";
import { type AgentSegment, narration } from "./segments.ts";

// Claude Code emits one `assistant` frame per content block — thinking, text,
// tool_use — all under the same message id, so the id alone cannot tell a new
// block from a replay. A frame is a replay only when the same message carries
// the same content again.
export function claudeAssistantFrameId(event: Record<string, unknown>): string | undefined {
  if (event.type !== "assistant") return undefined;
  const message = asRecord(event.message);
  if (typeof message.id !== "string" || !message.id) return undefined;
  return `assistant:${message.id}:${JSON.stringify(message.content ?? null)}`;
}

export function parseClaude(raw: string): AgentSegment[] {
  const out: AgentSegment[] = [];
  const text = new TextBuffer();
  const thinking = new TextBuffer();
  const streamedTextBlocks: string[] = [];
  const streamedTextByIndex = new Map<number, string>();
  const streamedTextWithoutIndex = new Set<string>();
  const toolSegmentById = new Map<string, number>();
  const seenAssistantFrameIds = new Set<string>();
  let activeTextIndex: number | undefined;
  let turnStartIndex = 0;

  const flushStreamedText = (index = activeTextIndex): void => {
    const blockText = text.drain();
    activeTextIndex = undefined;
    if (!blockText) return;
    const replayed = index === undefined
      ? streamedTextWithoutIndex.has(blockText)
      : streamedTextByIndex.get(index) === blockText;
    if (replayed) return;
    if (index === undefined) streamedTextWithoutIndex.add(blockText);
    else streamedTextByIndex.set(index, blockText);
    streamedTextBlocks.push(blockText);
    out.push({ kind: "text", text: blockText });
  };
  const resetTurnState = (): void => {
    streamedTextBlocks.length = 0;
    streamedTextByIndex.clear();
    streamedTextWithoutIndex.clear();
    toolSegmentById.clear();
  };

  for (const record of streamRecords(raw)) {
    if (record.kind === "text") {
      text.push(`${stripAnsi(record.text)}\n`);
      continue;
    }
    const event = record.value;
    if (event.type === "stream_event") {
      const streamEvent = asRecord(event.event);
      const delta = asRecord(streamEvent.delta);
      const block = asRecord(streamEvent.content_block);
      if (streamEvent.type === "content_block_start") {
        if (block.type === "tool_use") {
          flushStreamedText();
          thinking.flush(out, "thinking");
          const segment: AgentSegment = { kind: "tool", name: String(block.name ?? "tool"), target: toolTarget(asRecord(block.input)) };
          upsertSegmentById(out, toolSegmentById, typeof block.id === "string" ? block.id : undefined, segment);
        } else if (block.type === "text") {
          activeTextIndex = typeof streamEvent.index === "number" ? streamEvent.index : undefined;
        }
        continue;
      }
      if (streamEvent.type === "content_block_stop") {
        flushStreamedText(typeof streamEvent.index === "number" ? streamEvent.index : activeTextIndex);
        thinking.flush(out, "thinking");
        continue;
      }
      if (delta.type === "text_delta") {
        thinking.flush(out, "thinking");
        if (typeof streamEvent.index === "number") activeTextIndex = streamEvent.index;
        text.push(String(delta.text ?? ""));
      } else if (delta.type === "thinking_delta") {
        flushStreamedText();
        thinking.push(String(delta.thinking ?? ""));
      }
      continue;
    }
    if (event.type === "assistant") {
      const message = asRecord(event.message);
      const frameId = claudeAssistantFrameId(event);
      if (frameId && seenAssistantFrameIds.has(frameId)) {
        out.splice(turnStartIndex);
        resetTurnState();
        continue;
      }
      if (frameId) seenAssistantFrameIds.add(frameId);
      const content = Array.isArray(message.content) ? message.content : [];
      for (const item of content) {
        const block = asRecord(item);
        if (block.type === "text") {
          const blockText = String(block.text ?? "");
          thinking.flush(out, "thinking");
          flushStreamedText();
          const replayIndex = streamedTextBlocks.indexOf(blockText.trimEnd());
          if (replayIndex >= 0) streamedTextBlocks.splice(replayIndex, 1);
          else if (blockText) out.push({ kind: "text", text: blockText.trimEnd() });
        } else if (block.type === "tool_use") {
          flushStreamedText();
          thinking.flush(out, "thinking");
          const segment: AgentSegment = { kind: "tool", name: String(block.name ?? "tool"), target: toolTarget(asRecord(block.input)) };
          upsertSegmentById(out, toolSegmentById, typeof block.id === "string" ? block.id : undefined, segment);
        }
      }
      resetTurnState();
      turnStartIndex = out.length;
      continue;
    }
    if (event.type === "result") {
      flushStreamedText();
      thinking.flush(out, "thinking");
      if (event.is_error) {
        const message = String(event.result ?? "");
        out.push(message
          ? { kind: "status", tone: "bad", text: message }
          : narration("agent_stream.claude_error", undefined, "bad"));
      } else {
        // Some Claude Code builds (including the cloud-computer image) emit
        // the final response only on the result envelope. Prefer the richer
        // assistant/stream events when present, but never discard the sole
        // copy of a successful answer.
        const resultText = typeof event.result === "string" ? event.result.trimEnd() : "";
        const alreadyRendered = resultText
          ? out.some((segment) => segment.kind === "text" && sameRenderedText(segment.text.trimEnd(), resultText))
          : false;
        if (resultText && !alreadyRendered) out.push({ kind: "text", text: resultText });
        out.push(narration("agent_stream.claude_finished", undefined, "good"));
      }
      // A result frame closes the turn even when no assistant event carried
      // one (result-only builds). Reset replay suppression so the next turn's
      // text blocks are never mistaken for replays of this one.
      resetTurnState();
      turnStartIndex = out.length;
      continue;
    }
    if (event.type === "system" && event.subtype === "api_retry") {
      out.push(narration("agent_stream.claude_api_retry", {
        attempt: Number(event.attempt ?? "?"),
        max: Number(event.max_retries ?? "?"),
      }, "warn"));
    }
  }
  flushStreamedText();
  thinking.flush(out, "thinking");
  return out;
}
