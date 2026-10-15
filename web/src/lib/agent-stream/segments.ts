import type { Tone } from "../../types.ts";

export type AgentSegment =
  | { kind: "text"; text: string }
  | { kind: "thinking"; text: string }
  /** `id` is the CLI's own id for the call, present whenever the stream gives
   *  one. It is what makes a segment addressable across re-renders — see
   *  {@link segmentKeys}. */
  | { kind: "tool"; name: string; target?: string; id?: string }
  | { kind: "command"; command: string; id?: string }
  | { kind: "status"; tone: StatusTone; text: string }
  | { kind: "narration"; key: string; params?: Record<string, string | number> }
  | { kind: "raw"; text: string };

export type ToolSegment = Extract<AgentSegment, { kind: "tool" }>;

type StatusTone = Exclude<Tone, "neutral">;

export function narration(
  key: string,
  params?: Record<string, string | number>,
  tone?: StatusTone,
): AgentSegment {
  return { kind: "narration", key, params: tone ? { ...params, tone } : params };
}
