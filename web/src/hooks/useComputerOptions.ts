"use client";

import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { listSandboxes } from "../api";
import {
  computersForEmployee,
  computerName,
  type ComputerOwnership,
  type NodeLike,
} from "../lib/createAgent";
import type { SandboxRecord } from "../types";

/** GET /sandboxes carries workspaceId (the host machine id) alongside the
 *  fields relay-core's SandboxRecord already types — see
 *  core/computer_identity.py's computer_id() on the backend. */
type SandboxWithWorkspace = SandboxRecord & { workspaceId?: string };

export interface ComputerOption {
  /** Stable computer identity — what agents and teams record. */
  computerId: string;
  ownership: ComputerOwnership;
  label: string;
}

/** Maps a daemon node onto the identity shape createAgent.ts operates on.
 *  `sandbox.agents` is a status-dict keyed by every possible runtime kind
 *  (ready/failed/unknown), not a list of what's installed, so only
 *  `status === "ready"` entries are surfaced as supportedAgents. */
function toNodeLike(sandbox: SandboxWithWorkspace): NodeLike {
  const readyRuntimes = Object.entries(sandbox.agents ?? {})
    .filter(([, status]) => status === "ready")
    .map(([kind]) => kind);
  return {
    id: sandbox.id,
    employeeId: sandbox.employeeId,
    workspaceId: sandbox.workspaceId,
    managedNodeId: sandbox.managedNodeId,
    supportedAgents: readyRuntimes,
    disabledAgents: sandbox.disabledAgents,
  };
}

/**
 * The employee's computers, grouped by stable identity — one option per
 * machine however many runtime nodes it has had. Agent creation and team
 * setup both pick from this list, so the two always name computers the same
 * way.
 */
export function useComputerOptions(employeeId: string, enabled: boolean): {
  options: ComputerOption[];
  nodeLikes: NodeLike[];
  isLoading: boolean;
} {
  const query = useQuery({
    queryKey: ["computer-options", "sandboxes"],
    queryFn: ({ signal }: { signal: AbortSignal }) => listSandboxes(undefined, signal),
    enabled,
  });
  const sandboxes = useMemo(
    () => (query.data?.sandboxes ?? []) as SandboxWithWorkspace[],
    [query.data],
  );
  const nodeLikes = useMemo(() => sandboxes.map(toNodeLike), [sandboxes]);
  const options = useMemo(
    () => computersForEmployee(nodeLikes, employeeId).map((group) => {
      const primary = sandboxes.find((sandbox) => group.nodes.some((node) => node.id === sandbox.id));
      return {
        computerId: group.computerId,
        ownership: group.ownership,
        label: primary ? computerName(primary) : group.computerId,
      };
    }),
    [nodeLikes, sandboxes, employeeId],
  );
  return { options, nodeLikes, isLoading: query.isLoading };
}
