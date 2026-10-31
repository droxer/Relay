"use client";

import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { listDaemonNodes } from "../api";
import { nodesAssignedToUser } from "../lib/computerNodes";
import {
  computersForUser,
  computerName,
  type ComputerOwnership,
  type NodeLike,
} from "../lib/createAgent";
import type { DaemonNodeMonitorRecord } from "../types";

export interface ComputerOption {
  /** Stable computer identity — what agents and teams record. */
  computerId: string;
  ownership: ComputerOwnership;
  label: string;
}

/** Maps a daemon node onto the identity shape createAgent.ts operates on.
 *  `node.agents` is a status-dict keyed by every possible runtime kind
 *  (ready/failed/unknown), not a list of what's installed, so only
 *  `status === "ready"` entries are surfaced as supportedAgents. */
function toNodeLike(node: DaemonNodeMonitorRecord): NodeLike {
  const readyRuntimes = Object.entries(node.agents ?? {})
    .filter(([, status]) => status === "ready")
    .map(([kind]) => kind);
  return {
    id: node.id,
    userId: node.userId,
    workspaceId: node.workspaceId,
    managedNodeId: node.managedNodeId,
    supportedAgents: readyRuntimes,
    disabledAgents: node.disabledAgents,
    capabilities: node.capabilities,
    customModelEndpoints: node.customModelEndpoints,
    agentModels: node.agentModels,
    status: node.status,
  };
}

/**
 * The user's computers, grouped by stable identity — one option per
 * machine however many runtime nodes it has had. Agent creation and team
 * setup use the same roster and preferred daemon as My Computers. The legacy
 * sandbox list also includes retired records that must not become options.
 */
export function useComputerOptions(userId: string, enabled: boolean): {
  options: ComputerOption[];
  nodeLikes: NodeLike[];
  isLoading: boolean;
  isError: boolean;
  isFetching: boolean;
  retry: () => void;
} {
  const query = useQuery({
    queryKey: ["computer-options", "daemon-nodes", userId],
    queryFn: ({ signal }: { signal: AbortSignal }) => listDaemonNodes(undefined, signal),
    enabled,
  });
  const nodes = useMemo(
    () => nodesAssignedToUser(query.data?.nodes ?? [], userId),
    [query.data, userId],
  );
  const nodeLikes = useMemo(() => nodes.map(toNodeLike), [nodes]);
  const options = useMemo(
    () => computersForUser(nodeLikes, userId).map((group) => {
      const primary = nodes.find((candidate) => group.nodes.some((node) => node.id === candidate.id));
      return {
        computerId: group.computerId,
        ownership: group.ownership,
        label: primary ? computerName(primary) : group.computerId,
      };
    }),
    [nodeLikes, nodes, userId],
  );
  return { options, nodeLikes, isLoading: query.isLoading, isError: query.isError, isFetching: query.isFetching, retry: () => { void query.refetch(); } };
}
