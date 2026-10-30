import { visualStatus } from "./adminHelpers.ts";
import type { ControlPanelDaemonNodeRecord } from "../types.ts";

// One tone per state. "running" takes --live: a node running an agent is the
// one thing in Relay working right now. Stale is a warning (last-seen has
// lapsed), not a failure, so it takes --warn rather than sharing --err.
export type FleetTone = "live" | "good" | "bad" | "warn" | "neutral";
export type FleetKey = "running" | "ready" | "failed" | "stale" | "unknown";

export interface FleetSlot {
  key: FleetKey;
  tone: FleetTone;
  count: number;
  share: number;
}

export interface FleetSummary {
  slots: FleetSlot[];
  total: number;
  /** Ready or running: a computer that can take work. */
  available: number;
}

const ORDER: ReadonlyArray<{ key: FleetKey; tone: FleetTone }> = [
  { key: "running", tone: "live" },
  { key: "ready", tone: "good" },
  { key: "failed", tone: "bad" },
  { key: "stale", tone: "warn" },
  { key: "unknown", tone: "neutral" },
];

export function fleetSummary(nodes: readonly ControlPanelDaemonNodeRecord[]): FleetSummary {
  const counts = new Map<string, number>();
  for (const node of nodes) {
    const key = visualStatus(node);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const total = nodes.length;
  const slots = ORDER.map(({ key, tone }) => {
    const count = counts.get(key) ?? 0;
    return { key, tone, count, share: total > 0 ? count / total : 0 };
  });
  const available = (counts.get("running") ?? 0) + (counts.get("ready") ?? 0);
  return { slots, total, available };
}

/** An idle fleet stays fully grey: --live means work in flight, so a zero
 * running count must not glow. */
export function displayTone(slot: FleetSlot): FleetTone {
  return slot.tone === "live" && slot.count === 0 ? "neutral" : slot.tone;
}
