import type { AgentName } from "./state.js";

/**
 * A runtime CLI's own conversation id, read from its stream, so an interrupted
 * run can later be resumed inside the same conversation (`--resume`).
 *
 * Only Claude and Codex resume today; Pi and Kimi report nothing until their
 * resume flags are confirmed. The id is later passed back on a command line,
 * so anything but a plain id is refused.
 */
const SESSION_ID = /^[A-Za-z0-9_-]{8,128}$/;

export const RESUMABLE_AGENTS: readonly AgentName[] = ["claude", "codex"];

export function extractRuntimeSessionId(stdout: string, agent: AgentName): string | undefined {
  if (!RESUMABLE_AGENTS.includes(agent)) return undefined;
  for (const line of stdout.split("\n")) {
    if (!line.includes(agent === "codex" ? "thread_id" : "session_id")) continue;
    let event: Record<string, unknown>;
    try { event = JSON.parse(line) as Record<string, unknown>; } catch { continue; }
    const id = agent === "codex"
      ? event.type === "thread.started" ? event.thread_id : undefined
      : event.session_id;
    if (typeof id === "string") return SESSION_ID.test(id) ? id : undefined;
  }
  return undefined;
}

export function isResumableSessionId(value: unknown): value is string {
  return typeof value === "string" && SESSION_ID.test(value);
}
