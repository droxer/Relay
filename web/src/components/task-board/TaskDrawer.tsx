"use client";

import { type FormEvent, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { AgentTeam, EmployeeAgent } from "../../types";
import type { TaskBoardFormState } from "../../lib/taskBoardForm";
import { Drawer } from "@/components/ui/Drawer";
import { TaskBoardForm } from "./TaskBoardForm";

/* The backlog's record surface: the shared TaskBoardForm inside a drawer.
   The fields themselves live in TaskBoardForm because the routine board
   renders them in a detail pane instead — see the note there. */

type TaskDrawerProps = {
  open: boolean;
  form: TaskBoardFormState;
  logicalAgents: EmployeeAgent[];
  teams?: AgentTeam[];
  saving: boolean;
  title: string;
  subtitle: string;
  deleting?: boolean;
  /** Field that receives focus when the drawer opens. Quick-assign actions pass "assignment". */
  initialFocus?: "title" | "assignment";
  onClose: () => void;
  onChange: (next: TaskBoardFormState) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  onDelete?: () => void;
  /** Fires after the drawer's exit animation completes — release form state here. */
  onClosed?: () => void;
  /** Read-only context (status, linked thread, recent activity) shown above the form in edit mode. */
  meta?: ReactNode;
  /** Opens a thread in place from the run history; falls back to plain navigation. */
  onOpenThread?: (sessionId: string) => void;
};

export function TaskDrawer({
  open,
  form,
  logicalAgents,
  teams = [],
  saving,
  title,
  subtitle,
  deleting = false,
  initialFocus = "title",
  onClose,
  onChange,
  onSubmit,
  onDelete,
  onClosed,
  meta,
  onOpenThread,
}: TaskDrawerProps) {
  const { t } = useTranslation();
  const busy = saving || deleting;

  return (
    <Drawer
      open={open}
      onClose={() => {
        if (!busy) onClose();
      }}
      title={title}
      subtitle={subtitle}
      subtitleMono={Boolean(form.id)}
      width={form.variant === "routine" ? "routine" : "task"}
      closeLabel={t("drawer.close")}
      bodyClassName="adm-drawer-body--column"
      onClosed={onClosed}
    >
      <TaskBoardForm
        form={form}
        logicalAgents={logicalAgents}
        teams={teams}
        saving={saving}
        deleting={deleting}
        initialFocus={initialFocus}
        onChange={onChange}
        onSubmit={onSubmit}
        onDelete={onDelete}
        onCancel={onClose}
        meta={meta}
        onOpenThread={onOpenThread}
      />
    </Drawer>
  );
}
