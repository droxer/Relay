import type { EmployeeAgent } from "../types.js";
import { activePlacements, describeAgentPlacements, placementRuntimeNodeId } from "./agentPlacements.ts";

/** The band an agent with nowhere to run falls into; always sorted last. */
export const UNPLACED_GROUP_KEY = "__unplaced__";

interface AgentComputerGroup {
  /** Stable Computer identity, or `UNPLACED_GROUP_KEY`. */
  key: string;
  /** The computer's display name; `null` for the unplaced band, whose label
      is a translated string the caller owns. */
  label: string | null;
  agents: EmployeeAgent[];
}

/**
 * Band the roster by the infrastructure each agent runs on.
 *
 * The roster is read to answer "what is on this machine" as often as "what
 * agents do I have" — a computer hosts many agents, and an agent's whole
 * reason to be reachable is the computer behind it. Grouping by computer is
 * what lets the row drop its computer name: the band above it has already
 * said it, exactly as the backlog's status band replaced its status column.
 *
 * An agent placed on two computers appears under both — it genuinely runs on
 * both, and a band that silently omitted it would misdescribe the machine.
 * `removed` placements are dropped first (via `describeAgentPlacements`), so
 * a torn-down computer stops being a band as soon as it stops being a
 * destination, and an agent left with none sinks to the trailing band.
 */
export function groupAgentsByComputer(
  agents: readonly EmployeeAgent[],
): AgentComputerGroup[] {
  const groups = new Map<string, AgentComputerGroup>();
  const unplaced: EmployeeAgent[] = [];

  for (const agent of agents) {
    const descriptions = describeAgentPlacements(activePlacements(agent.placements));
    if (descriptions.length === 0) {
      unplaced.push(agent);
      continue;
    }
    for (const description of descriptions) {
      const { placement } = description;
      // Agent birth certificates were backfilled before legacy placement
      // snapshots. Prefer that same stable identity before falling all the way
      // back to a replaceable daemon id.
      const key = placement.computerId
        || agent.computerId
        || placementRuntimeNodeId(placement);
      const existing = groups.get(key);
      if (existing) {
        existing.agents.push(agent);
      } else {
        groups.set(key, { key, label: description.nodeName, agents: [agent] });
      }
    }
  }

  const ordered = [...groups.values()].sort((left, right) =>
    (left.label ?? "").localeCompare(right.label ?? "", undefined, { sensitivity: "base" })
    || left.key.localeCompare(right.key));

  if (unplaced.length > 0) {
    ordered.push({ key: UNPLACED_GROUP_KEY, label: null, agents: unplaced });
  }
  return ordered;
}
