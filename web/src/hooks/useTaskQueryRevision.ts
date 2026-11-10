import { useEffect } from "react";
import { useQueryClient, type QueryClient } from "@tanstack/react-query";

type TaskQuery = "task-record" | "task-events" | "task-runs" | "task-artifacts";

// Keep revision signals with the account's cache lifetime, rather than the
// mounted panel. Only small revision strings are retained, never responses.
const revisionsByClient = new WeakMap<QueryClient, Map<string, string | undefined>>();

/** Consume a changed revision after any older request settles. Remember it
 * across remounts, so a fresh cache entry cannot hide a newer parent revision. */
export function useTaskQueryRevision(
  collection: TaskQuery,
  taskId: string | null,
  revision: string | undefined,
  fetching: boolean,
): void {
  const queryClient = useQueryClient();
  useEffect(() => {
    if (!taskId) return;
    let revisions = revisionsByClient.get(queryClient);
    if (!revisions) {
      revisions = new Map();
      revisionsByClient.set(queryClient, revisions);
    }
    const key = JSON.stringify([collection, taskId]);
    if (!revisions.has(key)) {
      revisions.set(key, revision);
      // A pre-existing read with no revision association needs reconciliation.
      // A new read already in flight belongs to this first observed revision.
      if (fetching || !queryClient.getQueriesData({ queryKey: [collection, taskId] }).some(([, data]) => data !== undefined)) return;
    } else {
      if (revisions.get(key) === revision || fetching) return;
      revisions.set(key, revision);
    }
    if (revision === undefined) return;
    void queryClient.invalidateQueries(
      { queryKey: [collection, taskId] },
      { cancelRefetch: false },
    );
  }, [collection, fetching, queryClient, revision, taskId]);
}
