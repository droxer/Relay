import type { UserAgent } from "../types.js";

/** Defensive dedup by id — the roster renders the payload as-is, so a
 *  duplicated row anywhere upstream must not surface twice. */
export function dedupeAgentsById(agents: UserAgent[]): UserAgent[] {
  const seen = new Set<string>();
  return agents.filter((agent) => {
    if (seen.has(agent.id)) return false;
    seen.add(agent.id);
    return true;
  });
}
