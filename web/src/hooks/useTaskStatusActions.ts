import { useCallback, useSyncExternalStore } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { TASK_UPDATE_MUTATION_KEY, useRelayMutations, type TaskUpdateVariables } from "./useRelayMutations";

export type TaskStatusAction = "accept" | "unblock";

/**
 * The two moves a thread offers on its task without leaving for the record:
 * accepting work sitting in review, and lifting a block. Same mutation shapes
 * the record and the board use; a failure raises the mutation's own toast, so
 * each resolves false and the control comes back.
 */
export function useTaskStatusActions(taskId: string | undefined) {
  const { updateTaskMutation } = useRelayMutations();
  const { mutateAsync } = updateTaskMutation;
  const cache = useQueryClient().getMutationCache();
  const subscribe = useCallback((listener: () => void) => cache.subscribe(listener), [cache]);
  const readPendingAction = useCallback((): TaskStatusAction | null => {
    if (!taskId) return null;
    const updates = cache.findAll({ mutationKey: TASK_UPDATE_MUTATION_KEY, exact: true, status: "pending" });
    for (const update of updates) {
      const { taskId: target, input } = update.state.variables as TaskUpdateVariables;
      if (target !== taskId) continue;
      if (input.action === "unblock") return "unblock";
      if (input.status === "done") return "accept";
    }
    return null;
  }, [cache, taskId]);
  const busy = useSyncExternalStore(subscribe, readPendingAction, () => null);

  const run = useCallback(async (action: TaskStatusAction): Promise<boolean> => {
    // Read synchronously so a second click also sees requests started before
    // this component rendered, including from a previous visit to the Thread.
    if (!taskId || readPendingAction()) return false;
    try {
      await mutateAsync({ taskId, input: action === "accept" ? { status: "done" } : { action: "unblock" } });
      return true;
    } catch {
      return false;
    }
  }, [mutateAsync, readPendingAction, taskId]);

  return {
    busy,
    accept: useCallback(() => run("accept"), [run]),
    unblock: useCallback(() => run("unblock"), [run]),
  };
}
