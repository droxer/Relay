"use client";

import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useMediaQuery } from "../../hooks/useMediaQuery";
import { ActionEdit, ActionStart, AdminDelete, ICON, NavMore } from "../icons";
import { PHONE_QUERY } from "../MobileTopbarSlot";
import type { RelayTaskListItem } from "../../types";
import { recordActions, type RecordAction } from "./recordActions";

export function TaskRecordActions({
  task,
  readOnly = false,
  busyAction,
  onRun,
  onCancel,
  onDone,
  onEdit,
  onDelete,
}: {
  task: RelayTaskListItem;
  /** The task's project is closed for work — the record is readable, not actionable. */
  readOnly?: boolean;
  busyAction: RecordAction | null;
  onRun: () => void;
  onCancel: () => void;
  onDone: () => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const { t } = useTranslation();
  const phone = useMediaQuery(PHONE_QUERY);
  const actions = recordActions(task, { readOnly });
  // One action at a time: every button reads the same lock the record holds.
  const busy = busyAction !== null;
  /* Editing and deleting change the room too, so they go with the rest. An
     archived project keeps its records readable and nothing more. */
  if (readOnly) return null;

  return (
    <>
      {actions.includes("run") ? (
        <Button type="button" variant="default" size="dense" loading={busyAction === "run"} onClick={onRun}>
          <ActionStart size={ICON.sm} />
          {t("record.run_now")}
        </Button>
      ) : null}
      {actions.includes("triage") ? (
        /* Moving into a project happens in the edit form, where the project
           and the assignment it unlocks are chosen together. */
        <Button type="button" variant="default" size="dense" disabled={busy} onClick={onEdit}>
          {t("issues.add_to_project")}
        </Button>
      ) : null}
      {actions.includes("retry") ? (
        <Button type="button" variant="default" size="dense" loading={busyAction === "retry"} onClick={onRun}>
          <ActionStart size={ICON.sm} />
          {t("record.retry_run")}
        </Button>
      ) : null}
      {actions.includes("cancel") ? (
        <Button type="button" variant="outline" size="dense" loading={busyAction === "cancel"} onClick={onCancel}>
          {t("record.cancel_run")}
        </Button>
      ) : null}
      {actions.includes("done") ? (
        <Button type="button" variant="outline" size="dense" loading={busyAction === "done"} onClick={onDone}>
          {t("backlog.done")}
        </Button>
      ) : null}
      {/* Edit stays a button beside the state action; delete folds into one
          overflow menu on every width, so the irreversible action is never a
          red button the same size as the next step. A phone row has room for
          only the state action, so edit joins it in the menu there. */}
      {phone ? null : (
        <Button type="button" variant="outline" size="dense" disabled={busy} onClick={onEdit}>
          <ActionEdit size={ICON.sm} aria-hidden="true" />
          {t("record.edit")}
        </Button>
      )}
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button
              type="button"
              variant="outline"
              size="icon-dense"
              disabled={busy}
              loading={busyAction === "delete"}
              aria-label={t("record.more_actions")}
            >
              <NavMore size={ICON.md} aria-hidden="true" />
            </Button>
          }
        />
        <DropdownMenuContent align="end">
          {phone ? (
            <>
              <DropdownMenuItem onClick={onEdit}>
                <ActionEdit size={ICON.sm} aria-hidden="true" />
                {t("record.edit")}
              </DropdownMenuItem>
              <DropdownMenuSeparator />
            </>
          ) : null}
          {/* Plain "Delete" on both vocabularies: the record's title already
              names what goes, and the confirm dialog repeats it. */}
          <DropdownMenuItem danger onClick={onDelete}>
            <AdminDelete size={ICON.sm} aria-hidden="true" />
            {t("record.delete")}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </>
  );
}
