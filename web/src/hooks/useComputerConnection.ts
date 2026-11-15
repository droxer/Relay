import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { getComputerTransport } from "../api";
import { computerConnection, type ComputerConnection } from "../lib/computerConnection";
import type { ControlPanelDaemonNodeRecord } from "../types";

const TRANSPORT_REFRESH_MS = 15_000;

/**
 * A computer's connection reading for its owner: the liveness the node list
 * already carries, joined with what the computer's client last reported about
 * its own transport. Only a client that reports durably has a snapshot worth
 * asking for; without one the reading falls back to liveness alone.
 */
export function useComputerConnection(node: ControlPanelDaemonNodeRecord): ComputerConnection {
  const reports = Boolean(node.lastSeenAt) && Boolean(node.capabilities?.includes("durable-reports"));
  const transport = useQuery({
    queryKey: ["computer-transport", node.id],
    queryFn: ({ signal }) => getComputerTransport(node.id, signal),
    enabled: reports,
    retry: false,
    staleTime: TRANSPORT_REFRESH_MS,
    // A refusal (someone else's computer) is an answer; do not keep asking.
    refetchInterval: (query) => (query.state.status === "error" ? false : TRANSPORT_REFRESH_MS),
  });
  const snapshot = reports ? transport.data : undefined;
  return useMemo(() => computerConnection(node, snapshot), [node, snapshot]);
}
