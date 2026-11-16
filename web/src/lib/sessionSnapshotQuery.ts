import type { QueryClient } from "@tanstack/react-query";
import { getSession } from "../api";

/** Detail hydration and an SSE failure share one in-flight HTTP read. The
 * sessions collection owns the result; this key is only for deduplication,
 * and is intentionally outside the collection-wide refresh prefix. */
export function fetchSessionSnapshot(client: QueryClient, sessionId: string) {
  return client.fetchQuery({
    queryKey: ["session-snapshot", sessionId],
    queryFn: ({ signal }) => getSession(sessionId, signal),
    staleTime: 0,
    gcTime: 0,
    retry: false,
  });
}
