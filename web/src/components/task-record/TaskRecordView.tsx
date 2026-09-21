"use client";

import { useMemo, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { useDialogs } from "@/components/ui/DialogProvider";
import { Drawer } from "@/components/ui/Drawer";
import { useRelayMutations } from "../../hooks/useRelayMutations";
import { useTaskRecord } from "../../hooks/useTaskRecord";
import { pathForAppState } from "../../lib/appRoute";
import { runningRoutineIds } from "../../lib/routine";
import { taskStartMutationInput } from "../../lib/taskBoardForm";
import type { CurrentUser, RelayTaskListItem } from "../../types";
import { TaskRecordPage, recordTitle } from "./TaskRecordPage";
import type { RecordAction } from "./recordActions";
import { recordVariant } from "./recordVocabulary";

/**
 * The record surface with its data and its actions attached.
 *
 * Both boards mount this, so `/backlog/<id>`, `/routines/<id>` and
 * `/routines/<id>/runs/<occurrenceId>` answer to one implementation of what a
 * record can do. The boards keep the editing drawer — the record delegates
 * `onEdit` back to them rather than growing a second copy of the form.
 *
 * Two presentations: without `drawer` the record takes the whole route (the
 * standalone caller); with it the record renders inside the shared Drawer over
 * the task or routine list, and this wrapper lends the drawer its
 * header — the record's title, and the routine breadcrumb for a run.
 */
export function TaskRecordView({
  taskId,
  runId,
  currentUser,
  tasks,
  drawer,
  originLabel,
  tabSearchKey,
  onEdit,
  onOpenThread,
  onOpenRecord,
  onDeleted,
}: {
  /** The routine or task in the path. */
  taskId: string;
  /** The occurrence open as a run, when the path names one. */
  runId?: string | null;
  /** The viewer — assignment and assignee names resolve through their directories. */
  currentUser: CurrentUser;
  tasks: RelayTaskListItem[];
  /** Present the record as a drawer over the board rather than as the page. */
  drawer?: {
    open: boolean;
    onClose: () => void;
    /** Fires after the drawer's exit animation — release the mirrored record here. */
    onClosed?: () => void;
  };
  /** Where this record was opened from, when that is not one of the boards —
   *  a record riding over a project must not claim the backlog as its origin. */
  originLabel?: string;
  tabSearchKey?: "tab" | "recordTab";
  onEdit: (task: RelayTaskListItem) => void;
  onOpenThread: (sessionId: string) => void;
  onOpenRecord: (taskId: string, runId?: string | null) => void;
  onDeleted: () => void;
}) {
  const { t, i18n } = useTranslation();
  const { announce, confirm, prompt } = useDialogs();
  const { startTaskMutation, cancelRunMutation, deleteTaskMutation, updateTaskMutation } = useRelayMutations();
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
  const parentRoutine = runId && parent ? { id: parent.id, title: parent.title } : undefined;

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

  /* The state actions the retired peek drawer carried, with the same
     mutation shapes the backlog rows use. */
  async function toggleBlock(): Promise<void> {
    if (busyAction || !task) return;
    if (task.status === "blocked") {
      setBusyAction("unblock");
      try {
        await updateTaskMutation.mutateAsync({ taskId: task.id, input: { action: "unblock" } });
      } catch {
        // The toast is the report, the button comes back.
      } finally {
        setBusyAction(null);
      }
      return;
    }
    const reason = await prompt({ title: t("backlog.block_reason"), message: t("backlog.block_reason_hint") });
    if (!reason?.trim()) return;
    setBusyAction("block");
    try {
      await updateTaskMutation.mutateAsync({ taskId: task.id, input: { status: "blocked", blockerReason: reason.trim() } });
    } catch {
      // Same: the toast is the report, the button comes back.
    } finally {
      setBusyAction(null);
    }
  }

  async function markDone(): Promise<void> {
    if (busyAction || !task) return;
    setBusyAction("done");
    try {
      await updateTaskMutation.mutateAsync({ taskId: task.id, input: { status: "done" } });
    } catch {
      // Same: the toast is the report, the button comes back.
    } finally {
      setBusyAction(null);
    }
  }

  async function deleteRecord(): Promise<void> {
    if (busyAction || !task) return;
    const routine = recordVariant(task) === "routine";
    const confirmed = await confirm({
      title: t(routine ? "routine.delete_title" : "backlog.delete_title"),
      message: t(routine ? "routine.delete_body" : "backlog.delete_body", { title: task.title }),
      confirmLabel: t(routine ? "routine.delete_task" : "backlog.delete_task"),
      cancelLabel: t("dialog.cancel"),
      tone: "danger",
    });
    if (!confirmed) return;
    setBusyAction("delete");
    try {
      await deleteTaskMutation.mutateAsync({ taskId: task.id });
      announce({ message: t(routine ? "routine.toast_deleted" : "backlog.toast_deleted"), tone: "success" });
      onDeleted();
    } catch {
      // The toast reports it; the record stays open so the reader can retry.
    } finally {
      setBusyAction(null);
    }
  }

  let body: ReactNode;
  if (notFound || (!task && !isPending)) {
    body = (
      <section className="record-missing" role="status" tabIndex={-1}>
        <h1>{t("record.not_found_title")}</h1>
        <p>{error ?? t("record.not_found_body")}</p>
      </section>
    );
  } else if (!task) {
    body = <section className="record-missing" role="status" aria-live="polite">{t("record.loading")}</section>;
  /* A run addressed under a routine it does not belong to is not that run.
     Rendering it anyway would put a breadcrumb over it that lies. */
  } else if (runId && task.sourceRoutineId && task.sourceRoutineId !== taskId) {
    body = (
      <section className="record-missing" role="status" tabIndex={-1}>
        <h1>{t("record.not_found_title")}</h1>
        <p>{t("record.run_not_of_routine")}</p>
      </section>
    );
  } else {
    body = (
      <TaskRecordPage
        task={task}
        currentUser={currentUser}
        runningRoutineIds={running}
        parentRoutine={parentRoutine}
        busyAction={busyAction}
        presentation={drawer ? "drawer" : "page"}
        tabSearchKey={tabSearchKey}
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
        onToggleBlock={() => { void toggleBlock(); }}
        onDone={() => { void markDone(); }}
      />
    );
  }

  if (!drawer) return body;

  /* The drawer's header speaks for the record: the routine breadcrumb for a
     run, the board's name otherwise — the page presentation carries the same
     words in its own header. */
  const kicker = parentRoutine ? (
    <a
      className="record-back"
      href={pathForAppState({ route: "routine", mobileView: "chat", sessionId: null, taskId: parentRoutine.id })}
      onClick={(event) => {
        if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.altKey || event.ctrlKey || event.shiftKey) return;
        event.preventDefault();
        onOpenRecord(parentRoutine.id, null);
      }}
    >
      {parentRoutine.title}
    </a>
  ) : originLabel ?? t(task && recordVariant(task) === "task" ? "nav.backlog" : "nav.routine");

  return (
    <Drawer
      open={drawer.open}
      onClose={drawer.onClose}
      onClosed={drawer.onClosed}
      width="wide"
      kicker={kicker}
      title={task ? recordTitle(task, parentRoutine, i18n.language, t) : placeholder?.title ?? t("record.loading")}
      closeLabel={t("drawer.close")}
    >
      {body}
    </Drawer>
  );
}
