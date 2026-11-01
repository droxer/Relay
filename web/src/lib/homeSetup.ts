/**
 * Home's "Your setup" line: how many of the person's computers are online and
 * how many of their agents can take work, naming whatever cannot. Derived from
 * the nodes and agents the app already loads; nothing is stored.
 */
import type { DaemonNodeMonitorRecord, UserAgent } from "../types.js";
import { isUserAgentRoutable } from "./agentDisplayNames.ts";
import { computerId, computerName } from "./createAgent.ts";

export interface HomeSetup {
  computers: { total: number; online: number; offline: string[] };
  agents: { total: number; ready: number; unavailable: string[] };
}

const byName = (left: string, right: string) => left.localeCompare(right);

export function homeSetup(
  nodes: readonly DaemonNodeMonitorRecord[],
  agents: readonly UserAgent[],
  userId: string,
): HomeSetup {
  return { computers: computerSummary(nodes, userId), agents: agentSummary(agents) };
}

/** A machine can carry several node records (re-enrollments); it is one
 *  computer, online while any live record is. Liveness matches the queue's
 *  offline rule: a stale heartbeat is dark. */
function computerSummary(nodes: readonly DaemonNodeMonitorRecord[], userId: string): HomeSetup["computers"] {
  const machines = new Map<string, { name: string; online: boolean }>();
  for (const node of nodes) {
    if (node.userId !== userId || node.retiredAt) continue;
    const key = computerId(node);
    const live = node.online && !node.stale;
    const known = machines.get(key);
    machines.set(key, {
      name: known && !live ? known.name : computerName(node),
      online: Boolean(known?.online) || live,
    });
  }
  const all = [...machines.values()];
  return {
    total: all.length,
    online: all.filter((machine) => machine.online).length,
    offline: all.filter((machine) => !machine.online).map((machine) => machine.name).sort(byName),
  };
}

/** Disabled and deleted agents are switched off on purpose, so they are not
 *  counted; ready means routable — `busy` still takes work. */
function agentSummary(agents: readonly UserAgent[]): HomeSetup["agents"] {
  const active = agents.filter((agent) => agent.enabled && !agent.deletedAt);
  return {
    total: active.length,
    ready: active.filter(isUserAgentRoutable).length,
    unavailable: active.filter((agent) => !isUserAgentRoutable(agent)).map((agent) => agent.displayName).sort(byName),
  };
}
