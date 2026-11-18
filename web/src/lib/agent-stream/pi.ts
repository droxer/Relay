import { parsePiOutputLine, PiStreamDecoder, type PiOutputRecord } from "relay-core/pi-output";
import { toolInput, toolTarget, upsertSegmentById } from "./builders.ts";
import { stripAnsi } from "./records.ts";
import type { AgentSegment } from "./segments.ts";

export function piStreamRecords(raw: string): (PiOutputRecord & { end: number })[] {
  const records: (PiOutputRecord & { end: number })[] = [];
  const lines = raw.split("\n");
  let end = 0;
  for (let index = 0; index < lines.length; index++) {
    const complete = index < lines.length - 1;
    end += lines[index].length + (complete ? 1 : 0);
    const record = parsePiOutputLine(stripAnsi(lines[index]), complete);
    if (record) records.push({ ...record, end });
  }
  return records;
}

export function parsePi(raw: string): AgentSegment[] {
  const out: AgentSegment[] = [];
  const decoder = new PiStreamDecoder();
  const contentById = new Map<number, number>();
  const toolSegmentById = new Map<string, number>();
  let lastFailureIndex: number | undefined;
  for (const record of piStreamRecords(raw)) {
    if (record.kind === "text") {
      out.push({ kind: "text", text: record.text });
      continue;
    }
    if (record.value.type === "turn_start") {
      toolSegmentById.clear();
      lastFailureIndex = undefined;
    }
    for (const event of decoder.apply(record.value)) {
      if (event.kind === "text" || event.kind === "thinking") {
        const existing = contentById.get(event.id);
        if (existing !== undefined) {
          out[existing] = { kind: event.kind, text: event.text };
        } else {
          contentById.set(event.id, out.length);
          out.push({ kind: event.kind, text: event.text });
        }
      } else if (event.kind === "tool") {
        const target = toolTarget(toolInput(event.input));
        upsertSegmentById(out, toolSegmentById, event.id, {
          kind: "tool", name: event.name, ...(target ? { target } : {}),
        });
      } else if (event.kind === "error") {
        lastFailureIndex = out.length;
        out.push({ kind: "status", tone: "bad", text: event.legacy ? event.message : `Pi error: ${event.message}` });
      } else if (event.kind === "retry" && lastFailureIndex !== undefined) {
        const failure = out[lastFailureIndex];
        if (failure?.kind === "status") out[lastFailureIndex] = { ...failure, scope: "attempt" };
      } else if (event.kind === "snapshot") {
        const slots = event.blocks.map(({ id }) => contentById.get(id)!).sort((left, right) => left - right);
        for (const [index, block] of event.blocks.entries()) {
          const slot = slots[index]!;
          out[slot] = { kind: block.kind, text: block.text };
          contentById.set(block.id, slot);
        }
      }
    }
  }
  return out.flatMap<AgentSegment>((segment) => {
    if (segment.kind !== "text" && segment.kind !== "thinking") return [segment];
    const text = segment.text.trimEnd();
    return text ? [{ ...segment, text }] : [];
  });
}
