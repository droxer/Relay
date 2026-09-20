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
  busyAction,
  onRun,
  onCancel,
  onEdit,
  onDelete,
}: {
  task: RelayTaskListItem;
  variant: RecordVariant;
  busyAction: RecordAction | null;
  onRun: () => void;
  onCancel: () => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const { t } = useTranslation();
  const actions = recordActions(task);

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
      <Button type="button" variant="ghost" size="cta" onClick={onEdit}>
        {t("record.edit")}
      </Button>
      <Button type="button" variant="ghost" size="cta" onClick={onDelete}>
        {t(variant === "routine" ? "routine.delete_task" : "backlog.delete_task")}
      </Button>
    </>
  );
}
