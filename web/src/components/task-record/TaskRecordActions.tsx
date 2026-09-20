"use client";

import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { ActionStart, ICON } from "../icons";
import type { RelayTaskListItem } from "../../types";
import type { RecordVariant } from "./recordVocabulary";
import { recordActions, type RecordAction } from "./recordActions";

export function TaskRecordActions({
  task,
  variant,
  readOnly = false,
  busyAction,
  onRun,
  onCancel,
  onToggleBlock,
  onDone,
  onEdit,
  onDelete,
}: {
  task: RelayTaskListItem;
  variant: RecordVariant;
  /** The task's project is closed for work — the record is readable, not actionable. */
  readOnly?: boolean;
  busyAction: RecordAction | null;
  onRun: () => void;
  onCancel: () => void;
  onToggleBlock: () => void;
  onDone: () => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const { t } = useTranslation();
  const actions = recordActions(task, { readOnly });
  // One action at a time: every button reads the same lock the record holds.
  const busy = busyAction !== null;
  /* Editing and deleting change the room too, so they go with the rest. An
     archived project keeps its records readable and nothing more. */
  if (readOnly) return null;

  return (
    <>
      {actions.includes("run") ? (
        <Button type="button" variant="default" size="cta" loading={busyAction === "run"} onClick={onRun}>
          <ActionStart size={ICON.sm} />
          {t("record.run_now")}
        </Button>
      ) : null}
      {actions.includes("retry") ? (
        <Button type="button" variant="default" size="cta" loading={busyAction === "retry"} onClick={onRun}>
          <ActionStart size={ICON.sm} />
          {t("record.retry_run")}
        </Button>
      ) : null}
      {actions.includes("cancel") ? (
        <Button type="button" variant="outline" size="cta" loading={busyAction === "cancel"} onClick={onCancel}>
          {t("record.cancel_run")}
        </Button>
      ) : null}
      {actions.includes("block") ? (
        <Button type="button" variant="outline" size="cta" loading={busyAction === "block"} onClick={onToggleBlock}>
          {t("backlog.block")}
        </Button>
      ) : null}
      {actions.includes("unblock") ? (
        <Button type="button" variant="outline" size="cta" loading={busyAction === "unblock"} onClick={onToggleBlock}>
          {t("backlog.unblock")}
        </Button>
      ) : null}
      {actions.includes("done") ? (
        <Button type="button" variant="outline" size="cta" loading={busyAction === "done"} onClick={onDone}>
          {t("backlog.done")}
        </Button>
      ) : null}
      <Button type="button" variant="ghost" size="cta" disabled={busy} onClick={onEdit}>
        {t("record.edit")}
      </Button>
      {/* Destructive, and it says so. As a ghost beside Edit it was the one
          irreversible action on the record wearing the same clothes as the
          most reversible one — and with no busy state it took a second
          click before the first delete had landed. */}
      <Button
        type="button"
        variant="destructive"
        size="cta"
        loading={busyAction === "delete"}
        disabled={busy}
        onClick={onDelete}
      >
        {t(variant === "routine" ? "routine.delete_task" : "backlog.delete_task")}
      </Button>
    </>
  );
}
