import type { UserAgent } from "../types.js";
import { activePlacements, describeAgentPlacements } from "./agentPlacements.ts";

/**
 * Does this agent answer the roster's search box?
 *
 * The computer names are part of the haystack because the roster is banded by
 * computer: "what runs on the build box" is the question the rail is now shaped
 * to answer, and a search that could not reach a band name would empty the list
 * on the most obvious query the layout invites. Only ACTIVE placements count —
 * a torn-down computer has left the roster, so it must not keep matching.
 *
 * `blurb` is passed in rather than looked up: the per-runtime copy is
 * translated, and this module has no translator.
 */
export function agentMatchesQuery(
  agent: UserAgent,
  blurb: string,
  query: string,
): boolean {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return true;
  const computers = describeAgentPlacements(activePlacements(agent.placements))
    .map(({ nodeName }) => nodeName);
  const haystack = [
    agent.displayName,
    agent.id,
    agent.executorKind,
    blurb,
    agent.instructions ?? "",
    ...computers,
  ].join(" ").toLowerCase();
  return haystack.includes(normalized);
}
