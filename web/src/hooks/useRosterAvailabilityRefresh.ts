"use client";

import { useEffect, useMemo, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { nodeAvailabilitySignature, type NodeAvailabilityInput } from "../lib/relayPolling";
import { TEAMS_QUERY_KEY } from "./useTeams";
import { USER_AGENTS_QUERY_KEY } from "./useUserAgents";

/**
 * An agent's availability is derived from its computer, so the roster only
 * needs a fresh read when a computer's liveness or runtime readiness changes.
 * Following the nodes poll here is what lets the roster itself poll slowly.
 * The first reading only records a baseline: the roster loaded on its own.
 */
export function useRosterAvailabilityRefresh(nodes: readonly NodeAvailabilityInput[], ready: boolean): void {
  const queryClient = useQueryClient();
  const signature = useMemo(() => nodeAvailabilitySignature(nodes), [nodes]);
  const previous = useRef<string | null>(null);
  useEffect(() => {
    if (!ready) return;
    const last = previous.current;
    previous.current = signature;
    if (last === null || last === signature) return;
    void queryClient.invalidateQueries({ queryKey: [USER_AGENTS_QUERY_KEY] });
    void queryClient.invalidateQueries({ queryKey: [TEAMS_QUERY_KEY] });
  }, [queryClient, ready, signature]);
}
