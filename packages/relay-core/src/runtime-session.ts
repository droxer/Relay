import type { AgentName } from "./state.js";
import { parseJsonObject } from "./shell.js";

/**
 * A runtime CLI's own conversation id, read from its stream, so an interrupted
 * run can later be resumed inside the same conversation (`--resume`).
 *
 * The id is later passed back on a command line, so anything but a plain id
 * is refused.
 */
const SESSION_ID = /^[A-Za-z0-9_-]{8,128}$/;

export const RESUMABLE_AGENTS: readonly AgentName[] = ["claude", "codex", "antigravity"];

export function extractRuntimeSessionId(stdout: string, agent: AgentName): string | undefined {
  if (!RESUMABLE_AGENTS.includes(agent)) return undefined;
  for (const line of stdout.split("\n")) {
    const event = parseJsonObject(line);
    if (!event) continue;
    const id = agent === "codex"
      ? event.type === "thread.started" ? event.thread_id : undefined
      : agent === "antigravity" && event.type !== "relay.runtime.session" ? undefined : event.session_id;
    if (isResumableSessionId(id)) return id;
  }
  return undefined;
}

export function isResumableSessionId(value: unknown): value is string {
  return typeof value === "string" && SESSION_ID.test(value);
}

/** Retain startup metadata independently of the adapter's bounded transcript. */
export class RuntimeSessionStream {
  private pending = "";
  private oversized = false;
  private id: string | undefined;

  constructor(private readonly agent: AgentName) {}

  feed(chunk: string): void {
    if (this.id || !RESUMABLE_AGENTS.includes(this.agent)) return;
    let offset = 0;
    while (offset < chunk.length) {
      const newline = chunk.indexOf("\n", offset);
      const end = newline === -1 ? chunk.length : newline;
      // An unterminated/malformed event must not turn metadata capture into
      // an unbounded transcript. Startup records fit within this generous cap.
      if (!this.oversized && this.pending.length + end - offset <= 1_048_576) {
        this.pending += chunk.slice(offset, end);
      } else {
        this.pending = "";
        this.oversized = true;
      }
      if (newline === -1) break;
      if (!this.oversized) this.id = extractRuntimeSessionId(this.pending, this.agent);
      this.pending = "";
      this.oversized = false;
      if (this.id) return;
      offset = newline + 1;
    }
  }

  finish(): string | undefined {
    return this.id ?? (!this.oversized ? extractRuntimeSessionId(this.pending, this.agent) : undefined);
  }
}
