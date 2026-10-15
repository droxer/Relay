import { safeParse } from "./records.ts";
import type { AgentSegment } from "./segments.ts";

export function sameRenderedText(rendered: string, candidate: string): boolean {
  if (rendered === candidate) return true;
  if (!candidate.includes("\uFFFD")) return false;

  // BoxLite <= 0.9.5 decoded each gRPC byte chunk independently. When a
  // multibyte codepoint crossed a chunk boundary, the terminal result could
  // therefore contain one replacement character per byte while the preceding
  // assistant frame still held the intact reply. Treat only a long, highly
  // similar candidate as that historical corrupted copy; short or materially
  // different result-only replies must remain visible.
  const cleanLength = candidate.replace(/\uFFFD/g, "").length;
  if (cleanLength < 32 || cleanLength / Math.max(rendered.length, 1) < 0.9) return false;

  const pattern = candidate
    .split(/(\uFFFD+)/)
    .filter(Boolean)
    .map((part) => part[0] === "\uFFFD"
      ? `[\\s\\S]{0,${part.length}}`
      : part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("");
  return new RegExp(`^${pattern}$`).test(rendered);
}

export function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

export function toolInput(value: unknown): Record<string, unknown> {
  if (typeof value === "string") return safeParse(value) ?? {};
  return asRecord(value);
}

// A concise, single-line target for a tool call — the file it touched or the
// command it ran — pulled from the tool_use input so the transcript shows
// "Read backend/app.py" instead of a bare "Read". Best-effort: returns
// undefined when no recognizable field is present (or input hasn't streamed
// in yet), in which case the line renders as just the tool name.
const TOOL_TARGET_KEYS = [
  "command",
  "file_path",
  "path",
  "notebook_path",
  "pattern",
  "url",
  "query",
  "prompt",
  "description",
] as const;

export function toolTarget(input: Record<string, unknown>): string | undefined {
  for (const key of TOOL_TARGET_KEYS) {
    const value = input[key];
    if (typeof value === "string" && value.trim()) {
      const oneLine = value.trim().split("\n")[0]!.trim();
      return oneLine.length > 120 ? `${oneLine.slice(0, 119)}…` : oneLine;
    }
  }
  return undefined;
}

export function upsertSegmentById(
  out: AgentSegment[],
  segmentById: Map<string, number>,
  id: string | undefined,
  segment: AgentSegment,
): void {
  // The id rides along on the stored segment: the transcript keys its rows off
  // it, so a row keeps its React identity — and any state hanging off it — when
  // an earlier segment is inserted or replaced mid-stream.
  const identified = id && (segment.kind === "tool" || segment.kind === "command")
    ? { ...segment, id }
    : segment;
  const existing = id ? segmentById.get(id) : undefined;
  if (existing !== undefined) {
    out[existing] = mergeLifecycleSegment(out[existing], identified);
    return;
  }
  out.push(identified);
  if (id) segmentById.set(id, out.length - 1);
}

function mergeLifecycleSegment(previous: AgentSegment | undefined, next: AgentSegment): AgentSegment {
  if (previous?.kind === "tool" && next.kind === "tool" && !next.target && previous.target) {
    return { ...next, target: previous.target };
  }
  return next;
}

export class TextBuffer {
  private value = "";

  push(chunk: string): void {
    this.value += chunk;
  }

  drain(): string {
    const trimmed = this.value.trimEnd();
    this.value = "";
    return trimmed;
  }

  flush(out: AgentSegment[], kind: "text" | "thinking"): string {
    const trimmed = this.drain();
    if (trimmed) out.push({ kind, text: trimmed });
    return trimmed;
  }
}

export function textFromContent(record: Record<string, unknown>): string {
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
