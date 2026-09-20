"use client";

import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useDialogs } from "@/components/ui/DialogProvider";
import { useRelayMutations } from "../../hooks/useRelayMutations";
import { useTaskRecord } from "../../hooks/useTaskRecord";
import { runningRoutineIds } from "../../lib/routine";
import { taskStartMutationInput } from "../../lib/taskBoardForm";
import type { RelayTaskListItem } from "../../types";
import { TaskRecordPage } from "./TaskRecordPage";
import type { RecordAction } from "./recordActions";
import { recordVariant } from "./recordVocabulary";

/**
 * The record surface with its data and its actions attached.
 *
 * Both boards mount this, so `/backlog/<id>`, `/routines/<id>` and
 * `/routines/<id>/runs/<occurrenceId>` answer to one implementation of what a
 * record can do. The boards keep the editing drawer — the record delegates
 * `onEdit` back to them rather than growing a second copy of the form.
 */
export function TaskRecordView({
  taskId,
  runId,
  tasks,
  onEdit,
  onOpenThread,
  onOpenRecord,
  onDeleted,
}: {
  /** The routine or task in the path. */
  taskId: string;
  /** The occurrence open as a run, when the path names one. */
  runId?: string | null;
  tasks: RelayTaskListItem[];
  onEdit: (task: RelayTaskListItem) => void;
  onOpenThread: (sessionId: string) => void;
  onOpenRecord: (taskId: string, runId?: string | null) => void;
  onDeleted: () => void;
}) {
  const { t } = useTranslation();
  const { announce, confirm } = useDialogs();
  const { startTaskMutation, cancelRunMutation, deleteTaskMutation } = useRelayMutations();
  const [busyAction, setBusyAction] = useState<RecordAction | null>(null);

  // The record in the path — the run when there is one, otherwise the
  // routine or task itself.
  const recordId = runId ?? taskId;
  const placeholder = useMemo(() => tasks.find((task) => task.id === recordId), [tasks, recordId]);
  const { task, isPending, notFound, error } = useTaskRecord(recordId, placeholder);
  const parent = useMemo(
    () => (runId ? tasks.find((candidate) => candidate.id === taskId) : undefined),
    [runId, taskId, tasks],
  );
  const running = useMemo(() => runningRoutineIds(tasks), [tasks]);

  if (notFound || (!task && !isPending)) {
    return (
      <section className="record-missing" role="status" tabIndex={-1}>
        <h1>{t("record.not_found_title")}</h1>
        <p>{error ?? t("record.not_found_body")}</p>
      </section>
    );
  }
  if (!task) {
    return <section className="record-missing" role="status" aria-live="polite">{t("record.loading")}</section>;
  }
  /* A run addressed under a routine it does not belong to is not that run.
     Rendering it anyway would put a breadcrumb over it that lies. */
  if (runId && task.sourceRoutineId && task.sourceRoutineId !== taskId) {
    return (
      <section className="record-missing" role="status" tabIndex={-1}>
        <h1>{t("record.not_found_title")}</h1>
        <p>{t("record.run_not_of_routine")}</p>
      </section>
    );
  }

  async function runRecord(): Promise<void> {
    if (busyAction || !task) return;
    setBusyAction(task.isRoutine ? "run" : "retry");
    try {
      await startTaskMutation.mutateAsync(taskStartMutationInput(task));
    } catch {
      // The mutation's onError raises the toast; the action stays available.
    } finally {
      setBusyAction(null);
    }
  }

  async function cancelRecord(): Promise<void> {
    if (busyAction || !task) return;
    const sessionId = task.linkedSessionIds.at(-1);
    if (!sessionId) return;
    setBusyAction("cancel");
    try {
      await cancelRunMutation.mutateAsync({ sessionId });
    } catch {
      // Same: the toast is the report, the button comes back.
    } finally {
      setBusyAction(null);
    }
  }

  async function deleteRecord(): Promise<void> {
    if (!task) return;
    const routine = recordVariant(task) === "routine";
    const confirmed = await confirm({
      title: t(routine ? "routine.delete_title" : "backlog.delete_title"),
      message: t(routine ? "routine.delete_body" : "backlog.delete_body", { title: task.title }),
      confirmLabel: t(routine ? "routine.delete_task" : "backlog.delete_task"),
      cancelLabel: t("dialog.cancel"),
      tone: "danger",
    });
    if (!confirmed) return;
    try {
      await deleteTaskMutation.mutateAsync({ taskId: task.id });
      announce({ message: t(routine ? "routine.toast_deleted" : "backlog.toast_deleted"), tone: "success" });
      onDeleted();
    } catch {
      // The toast reports it; the record stays open so the reader can retry.
    }
  }

  return (
    <TaskRecordPage
      task={task}
      runningRoutineIds={running}
      parentRoutine={runId && parent ? { id: parent.id, title: parent.title } : undefined}
      busyAction={busyAction}
      onOpenThread={onOpenThread}
      onOpenRun={(nextId) => {
        // The breadcrumb passes the routine's own id; a row passes a run's.
        if (nextId === taskId) onOpenRecord(taskId, null);
        else onOpenRecord(taskId, nextId);
      }}
      onRun={() => { void runRecord(); }}
      onCancel={() => { void cancelRecord(); }}
      onEdit={() => onEdit(task)}
      onDelete={() => { void deleteRecord(); }}
    />
  );
}
