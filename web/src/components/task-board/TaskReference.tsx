"use client";

import { useTranslation } from "react-i18next";
import { taskRef } from "../../lib/taskRef";

/** A quiet, human-quotable task identity for card layouts.
 *
 * No "REF" label. `T-1001` in the mono face already reads as a reference, and
 * the word was spelled out on every card on both boards — a column header's
 * worth of chrome repeated per record. The full id stays in the title
 * attribute, which is where it was always read from. */
export function TaskReference({ taskId }: { taskId: string }) {
  const { t } = useTranslation();

  return (
    <span className="backlog-task-ref code" title={taskId} aria-label={`${t("backlog.col_ref")} ${taskRef(taskId)}`}>
      {taskRef(taskId)}
    </span>
  );
}
