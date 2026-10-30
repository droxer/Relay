"use client";

import { useTranslation } from "react-i18next";
import { useDialogs } from "@/components/ui/DialogProvider";
import { useRelayMutations } from "./useRelayMutations";
import { taskDropRejection } from "../lib/taskDrag";
import { taskHoldAction } from "../lib/taskFlow";
import { taskStartMutationInput } from "../lib/taskBoardForm";
import { taskAssignmentEditable, taskAssignmentPatch, type TaskAssignmentChange } from "../lib/taskAssignment";
import type { RelayTaskListItem, TaskPriority, TaskStatus } from "../types";

export interface InlineTaskEdits {
  changeStatus: (task: RelayTaskListItem, status: TaskStatus) => void;
  /** Block (asking why) or unblock — see `taskHoldAction`. */
  toggleHold: (task: RelayTaskListItem) => Promise<void>;
  changePriority: (task: RelayTaskListItem, priority: TaskPriority) => void;
  changeDue: (task: RelayTaskListItem, dueDate: string) => void;
  changeAssignment: (task: RelayTaskListItem, change: TaskAssignmentChange) => void;
}

/**
 * The one commit path for editing a task's properties outside its record — a
 * board drop, an inline menu, and the record's status control all land here, so they cannot disagree about
 * which moves are allowed or how a refusal is reported. `null` when the
 * surface is read-only, which is what tells a row to render plain marks.
 */
export function useInlineTaskEdits({ readOnly = false }: { readOnly?: boolean } = {}): InlineTaskEdits | null {
  const { t } = useTranslation();
  const { announce, prompt } = useDialogs();
  const { startTaskMutation, updateTaskMutation } = useRelayMutations();
  if (readOnly) return null;

  return {
    changeStatus(task, status) {
      const rejection = taskDropRejection(task, status);
      if (rejection === "needs_assignment") {
        announce({ message: t("backlog.drop_needs_assignment"), tone: "error" });
        return;
      }
      if (rejection) return;
      if (status === "running") {
        startTaskMutation.mutate(taskStartMutationInput(task));
        return;
      }
      updateTaskMutation.mutate({ taskId: task.id, input: { status } }, {
        onSuccess: () => announce({
          message: t("backlog.drop_moved", { title: task.title, status: t(`backlog.statuses.${status}`) }),
          tone: "success",
        }),
      });
    },
    async toggleHold(task) {
      const action = taskHoldAction(task);
      if (action === "unblock") {
        updateTaskMutation.mutate({ taskId: task.id, input: { action: "unblock" } });
        return;
      }
      if (action !== "block") return;
      const reason = (await prompt({ title: t("backlog.block_reason"), message: t("backlog.block_reason_hint") }))?.trim();
      if (!reason) return;
      updateTaskMutation.mutate({ taskId: task.id, input: { status: "blocked", blockerReason: reason } });
    },
    changePriority(task, priority) {
      updateTaskMutation.mutate({ taskId: task.id, input: { priority } });
    },
    changeDue(task, dueDate) {
      updateTaskMutation.mutate({ taskId: task.id, input: { dueDate } });
    },
    changeAssignment(task, change) {
      if (!taskAssignmentEditable(task)) return;
      updateTaskMutation.mutate({ taskId: task.id, input: taskAssignmentPatch(task, change) });
    },
  };
}
