import type { QueryClient } from "@tanstack/react-query";
import { getSession, type SessionSnapshotCache } from "../api";

/** Detail hydration and an SSE failure share one in-flight HTTP read. The
 * merged sessions collection can advance through SSE. Keep the last HTTP
 * snapshot separately so the next read can validate its exact event prefix. */
export async function fetchSessionSnapshot(client: QueryClient, sessionId: string, options?: { reuseRecent?: boolean }) {
  const queryKey = ["session-snapshot", sessionId] as const;
  const result = await client.fetchQuery({
    queryKey,
    queryFn: async ({ signal }) => {
      const cache = { ...client.getQueryData<SessionSnapshotCache>(queryKey) };
      const snapshot = await getSession(sessionId, signal, cache);
      return { ...cache, snapshot };
    },
    staleTime: options?.reuseRecent && !client.isFetching({ queryKey, exact: true }) ? 5_000 : 0,
    gcTime: 2 * 60_000,
    structuralSharing: false,
    retry: false,
  });
  return result.snapshot;
}
