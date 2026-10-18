import { useCallback, useState } from "react";
import { useRelayMutations } from "./useRelayMutations";

export type TaskStatusAction = "accept" | "unblock";

/**
 * The two moves a thread offers on its task without leaving for the record:
 * accepting work sitting in review, and lifting a block. Same mutation shapes
 * the record and the board use; a failure raises the mutation's own toast, so
 * each resolves false and the control comes back.
 */
export function useTaskStatusActions(taskId: string | undefined) {
  const { updateTaskMutation } = useRelayMutations();
  const [busy, setBusy] = useState<TaskStatusAction | null>(null);
  const { mutateAsync } = updateTaskMutation;

  const run = useCallback(async (action: TaskStatusAction): Promise<boolean> => {
    if (!taskId || busy) return false;
    setBusy(action);
    try {
      await mutateAsync({ taskId, input: action === "accept" ? { status: "done" } : { action: "unblock" } });
      return true;
    } catch {
      return false;
    } finally {
      setBusy(null);
    }
  }, [busy, mutateAsync, taskId]);

  return {
    busy,
    accept: useCallback(() => run("accept"), [run]),
    unblock: useCallback(() => run("unblock"), [run]),
  };
}
