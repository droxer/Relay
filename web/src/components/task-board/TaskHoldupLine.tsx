import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";
import { TaskStatusIcon } from "../TaskStatusIcon";
import { taskHoldup } from "../../lib/taskExceptions";
import type { RelayTaskListItem } from "../../types";

/**
 * One line naming what a task is held up on — the blocker, or the question a
 * person owes it — drawn the same on the board tile and every list row.
 *
 * A blocked task keeps the lane of the stage it was blocked from, so without
 * this the board showed it as ordinary work in progress and the list said
 * "Blocked" without ever saying why. The glyph and the status word carry the
 * tone; the reason stays in body ink so a red paragraph never shouts.
 */
export function TaskHoldupLine({ task, className, labeled = false }: {
  task: RelayTaskListItem;
  className?: string;
  /** Spell the status word. A tile needs it — its lane names another stage —
   *  but a row already has a Status column (or a status band) beside it. */
  labeled?: boolean;
}) {
  const { t } = useTranslation();
  const holdup = taskHoldup(task);
  if (!holdup) return null;
  const label = t(`backlog.statuses.${task.status}`);
  const text = holdup.text ?? t(holdup.kind === "blocked" ? "blocker.no_reason" : "blocker.no_question");
  return (
    <span className={cn("task-holdup", className)} data-kind={holdup.kind} title={`${label}: ${text}`}>
      <TaskStatusIcon status={task.status} />
      {labeled ? <span className="task-holdup-label">{label}</span> : <span className="sr-only">{label}:</span>}
      <span className={cn("task-holdup-text", !holdup.text && "task-holdup-text--none")}>{text}</span>
    </span>
  );
}
