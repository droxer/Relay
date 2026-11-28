import { useCallback, useRef, useState } from "react";
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
  const operations = useRef(new Map<string, TaskStatusAction>());
  const [pending, setPending] = useState<ReadonlyMap<string, TaskStatusAction>>(() => new Map());
  const { mutateAsync } = updateTaskMutation;

  const run = useCallback(async (action: TaskStatusAction): Promise<boolean> => {
    if (!taskId || operations.current.has(taskId)) return false;
    operations.current.set(taskId, action);
    setPending(new Map(operations.current));
    try {
      await mutateAsync({ taskId, input: action === "accept" ? { status: "done" } : { action: "unblock" } });
      return true;
    } catch {
      return false;
    } finally {
      operations.current.delete(taskId);
      setPending(new Map(operations.current));
    }
  }, [mutateAsync, taskId]);

  return {
    busy: taskId ? pending.get(taskId) ?? null : null,
    accept: useCallback(() => run("accept"), [run]),
    unblock: useCallback(() => run("unblock"), [run]),
  };
}
