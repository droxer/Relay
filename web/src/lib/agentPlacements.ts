import type { AgentPlacement } from "../types.js";

export type PlacementOwnership = "managed" | "local" | "pending";
export type PlacementSandbox = "boxlite" | "host" | "pending";
export type PlacementPreference = "preferred" | "alternate";

type PlacementStatusTone = "good" | "info" | "warn" | "bad" | "neutral";

/**
 * The placements an agent actually runs on right now.
 *
 * A placement torn down keeps its row until the daemon confirms, so every
 * surface that lists an agent's computers has to drop `removed` first. This
 * lived privately in AgentsPage while the team surfaces read `agent.placements`
 * raw — so a removed computer stayed visible in a team long after it had gone
 * from the roster.
 */
export function activePlacements(placements: readonly AgentPlacement[]): AgentPlacement[] {
  return placements.filter((placement) => placement.desiredState !== "removed");
}

export function placementStatusTone(status: AgentPlacement["status"]): PlacementStatusTone {
  if (status === "ready") return "good";
  if (status === "busy") return "info";
  if (status === "pending") return "warn";
  if (status === "failed" || status === "incompatible") return "bad";
  return "neutral";
}

export interface AgentPlacementDescription {
  placement: AgentPlacement;
  nodeName: string;
  ownership: PlacementOwnership;
  sandbox: PlacementSandbox;
  /** Configured route order. Draining placements do not accept work. */
  preference: PlacementPreference | null;
}

interface PlacementBadgeLabels {
  nodeName: string;
  ownership: string;
  sandboxLabel: string;
  status: string;
}

export function placementRuntimeNodeId(placement: AgentPlacement): string {
  return placement.runtimeNodeId || placement.daemonNodeId;
}

export function placementBadgeShowsSandbox(
  sandbox: PlacementSandbox,
  requested: boolean,
): boolean {
  return requested && sandbox !== "host";
}

export function placementBadgeDetailLabels(
  labels: PlacementBadgeLabels,
  includeSandbox: boolean,
): string[] {
  return [
    labels.nodeName,
    labels.ownership,
    ...(includeSandbox ? [labels.sandboxLabel] : []),
    labels.status,
  ];
}

export function describeAgentPlacements(
  placements: AgentPlacement[],
): AgentPlacementDescription[] {
  let activeIndex = 0;
  // One Computer per row. daemonNodeId is only the runtime observed when the
  // placement was created and may be replaced without moving the Agent.
  const seenComputers = new Set<string>();
  return placements
    .filter((placement) => placement.desiredState !== "removed")
    .sort((left, right) => left.priority - right.priority || left.id.localeCompare(right.id))
    .filter((placement) => {
      const computer = placement.computerId || placementRuntimeNodeId(placement);
      if (seenComputers.has(computer)) return false;
      seenComputers.add(computer);
      return true;
    })
    .map((placement) => ({
      placement,
      nodeName: placement.nodeDisplayName || placementRuntimeNodeId(placement),
      ownership: placement.nodeOwnership === "managed"
        ? "managed"
        : placement.nodeOwnership === "employee-device"
          ? "local"
          : "pending",
      sandbox: placement.nodeSandboxMode === "boxlite"
        ? "boxlite"
        : placement.nodeSandboxMode === "none"
          ? "host"
          : "pending",
      preference: placement.desiredState === "active"
        ? activeIndex++ === 0 ? "preferred" : "alternate"
        : null,
    }));
}
