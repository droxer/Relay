"use client";

import { useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { useDialogs } from "@/components/ui/DialogProvider";
import { useRelayMutations } from "./useRelayMutations";
import { useUnsavedChangesGuard } from "./useUnsavedChangesGuard";
import {
  taskAssignmentMutationFields,
  taskBoardFormsEqual,
  type BacklogTaskFormState,
} from "../lib/taskBoardForm";
import type { CurrentUser, RelayTaskListItem } from "../types";

/**
 * The backlog task form, as one controller.
 *
 * The board owned this outright, which meant any other surface that wanted to
 * edit a task had the choice of sending the reader to the board or growing a
 * second copy of the form — and a second copy is how two surfaces end up
 * disagreeing about what saving a task does. The project board opens the same
 * record drawer the backlog does, so it edits through the same form.
 *
 * `seed` is what a surface adds to every task it creates or edits — the
 * project board pins `projectId`, so a task created there belongs to the
 * project without the form having to know about projects at all.
 */
export function useBacklogTaskForm({
  currentUser,
  seed,
  allowIntake = false,
}: {
  currentUser: CurrentUser;
  seed?: { projectId?: string };
  /** The Issues page may file an issue with no project (intake) and triage
      one into a project later. A project's own board never does either. */
  allowIntake?: boolean;
}) {
  const { t } = useTranslation();
  const { announce, confirm } = useDialogs();
  const { updateTaskMutation, createTaskMutation, deleteTaskMutation } = useRelayMutations();
  const [form, setForm] = useState<BacklogTaskFormState | null>(null);
  const [formBaseline, setFormBaseline] = useState<BacklogTaskFormState | null>(null);
  const [open, setOpen] = useState(false);
  const [assignmentFocus, setAssignmentFocus] = useState(false);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const dirty = Boolean(form && formBaseline && !taskBoardFormsEqual(form, formBaseline));
  const confirmDiscardChanges = useUnsavedChangesGuard(dirty && !saving && !deleting);

  function openForm(next: BacklogTaskFormState): void {
    const seeded = { ...next, projectId: next.projectId || seed?.projectId };
    setForm(seeded);
    setFormBaseline(seeded);
    setOpen(true);
  }

  function editTask(task: RelayTaskListItem): void {
    openForm({
      variant: "backlog",
      id: task.id,
      projectId: task.projectId,
      sourceRoutineId: task.sourceRoutineId,
      title: task.title,
      description: task.description,
      priority: task.priority,
      status: task.status,
      acceptancePolicy: task.acceptancePolicy ?? "automatic",
      collaborationStyle: task.collaborationStyle ?? null,
      startedAt: task.startedAt,
      dueDate: task.dueDate ?? "",
      assigneeEmployeeId:
        task.assigneeEmployeeId ?? task.ownerEmployeeId ?? currentUser.employeeId ?? currentUser.username,
      assignedAgent: task.assignedAgent ?? "",
      assignedAgentId: task.assignedAgentId ?? "",
      assignedTeamId: task.assignedTeamId ?? "",
    });
  }

  /** Quick-assign entry from a card or row: same drawer, focus on the picker. */
  function assignTask(task: RelayTaskListItem): void {
    setAssignmentFocus(true);
    editTask(task);
  }

  function dismiss(): void {
    setOpen(false);
  }

  /** The drawer calls this after its exit animation — only then is the form
   *  released, so every exit (save, delete, discard) animates out. */
  function release(): void {
    setForm(null);
    setFormBaseline(null);
    setAssignmentFocus(false);
  }

  async function requestClose(): Promise<void> {
    if (!open || saving || deleting) return;
    if (!(await confirmDiscardChanges())) return;
    dismiss();
  }

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!form || !form.title.trim() || (!form.id && !form.projectId && !allowIntake)) return;
    /* A project chosen for an intake issue is a move: it rides the same PATCH
       as the assignment, and the server applies the move first. */
    const movesIntoProject = Boolean(form.id && form.projectId && !formBaseline?.projectId);
    const intake = !form.projectId && !form.sourceRoutineId;
    setSaving(true);
    try {
      const payload: import("../types").TaskMutationInput & { title: string } = {
        title: form.title.trim(),
        description: form.description,
        priority: form.priority,
        ...(form.status !== formBaseline?.status ? { status: form.status } : {}),
        acceptancePolicy: form.acceptancePolicy ?? "human",
        collaborationStyle: form.assignedTeamId ? (form.collaborationStyle === "solo" ? "build_review" : form.collaborationStyle ?? "") : "",
        dueDate: form.dueDate,
        /* Intake takes no agent or team. Clearing is still sent for a legacy
           issue that carried one, which is the one change it may make. */
        ...(intake && !form.id ? {} : taskAssignmentMutationFields(form)),
        ...(movesIntoProject ? { projectId: form.projectId } : {}),
      };
      if (form.id) await updateTaskMutation.mutateAsync({ taskId: form.id, input: payload });
      else await createTaskMutation.mutateAsync({ ...payload, ...(form.projectId ? { projectId: form.projectId } : {}) });
      dismiss();
    } catch {
      // mutation onError surfaces a toast; keep the drawer open for retry.
    } finally {
      setSaving(false);
    }
  }

  async function remove(): Promise<void> {
    if (!form?.id || deleting) return;
    const confirmed = await confirm({
      title: t("backlog.delete_title"),
      message: t("backlog.delete_body", { title: form.title }),
      confirmLabel: t("backlog.delete_task"),
      cancelLabel: t("dialog.cancel"),
      tone: "danger",
    });
    if (!confirmed) return;
    setDeleting(true);
    try {
      await deleteTaskMutation.mutateAsync({ taskId: form.id });
      dismiss();
      announce({ message: t("backlog.toast_deleted"), tone: "success" });
    } catch {
      // mutation onError surfaces a toast; keep the drawer open for retry.
    } finally {
      setDeleting(false);
    }
  }

  /* Locked once a record has a project; open for a new record, and for a
     saved intake issue on a surface that triages. */
  const projectChoice: "required" | "optional" | "locked" = !form?.id
    ? (allowIntake ? "optional" : "required")
    : allowIntake && !formBaseline?.projectId && !formBaseline?.sourceRoutineId ? "optional" : "locked";

  return {
    form,
    setForm,
    projectChoice,
    open,
    assignmentFocus,
    saving,
    deleting,
    openForm,
    editTask,
    assignTask,
    release,
    requestClose,
    submit,
    remove,
  };
}
