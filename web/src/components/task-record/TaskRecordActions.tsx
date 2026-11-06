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
  readingFile = false,
  busyAction,
  onRun,
  onCancel,
  onEdit,
  onDelete,
  onWatchLive,
}: {
  task: RelayTaskListItem;
  /** The task's project is closed for work — the record is readable, not actionable. */
  readOnly?: boolean;
  /** Let file navigation lead on phones; execution stays in More actions. */
  readingFile?: boolean;
  busyAction: RecordAction | null;
  onRun: () => void;
  onCancel: () => void;
  onDone: () => void;
  onEdit: () => void;
  onDelete: () => void;
  /** Opens the thread the running round streams into; absent when none. */
  onWatchLive?: () => void;
}) {
  const { t } = useTranslation();
  const phone = useMediaQuery(PHONE_QUERY);
  const actions = recordActions(task, { readOnly });
  // One action at a time: every button reads the same lock the record holds.
  const busy = busyAction !== null;
  const compact = phone && readingFile;
  /* Editing and deleting change the room too, so they go with the rest. An
     archived project keeps its records readable and nothing more. */
  if (readOnly) return null;

  return (
    <>
      {actions.includes("run") && !compact ? (
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
      {actions.includes("retry") && !compact ? (
        <Button type="button" variant="default" size="dense" loading={busyAction === "retry"} onClick={onRun}>
          <ActionStart size={ICON.sm} />
          {t("record.retry_run")}
        </Button>
      ) : null}
      {/* A running task's work is visible only in its thread; the record
          would otherwise show a status with no way to watch it. */}
      {task.status === "running" && onWatchLive ? (
        <Button type="button" variant="outline" size="dense" disabled={busy} onClick={onWatchLive}>
          {t("record.watch_live")}
        </Button>
      ) : null}
      {/* Cancelling stops a live run at once, unconfirmed. On a phone it would
          be the row's only button, read as the next step and one stray tap
          from ending the agent's work, so it waits in the menu there. */}
      {actions.includes("cancel") && !phone ? (
        <Button type="button" variant="outline" size="dense" loading={busyAction === "cancel"} onClick={onCancel}>
          {t("record.cancel_run")}
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
          {compact && (actions.includes("run") || actions.includes("retry")) ? (
            <DropdownMenuItem disabled={busy} onClick={onRun}>
              <ActionStart size={ICON.sm} aria-hidden="true" />
              {t(actions.includes("retry") ? "record.retry_run" : "record.run_now")}
            </DropdownMenuItem>
          ) : null}
          {phone ? (
            <>
              {actions.includes("cancel") ? (
                <DropdownMenuItem onClick={onCancel}>
                  {t("record.cancel_run")}
                </DropdownMenuItem>
              ) : null}
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
