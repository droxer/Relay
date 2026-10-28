import { useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";
import { Popover, PopoverContent, PopoverTrigger, PopoverTitle, PopoverDescription } from "@/components/ui/popover";
import { TaskStatusIcon } from "../TaskStatusIcon";
import { taskHoldup } from "../../lib/taskExceptions";
import { waitingOnRefs } from "../../lib/taskPrerequisites";
import { TASKS_QUERY_KEY } from "../../hooks/useRelayData";
import type { RelayTaskListItem, RelayTaskSummary } from "../../types";

/**
 * One line naming what a task is held up on — the blocker, the question a
 * person owes it, or the prerequisites it waits for — drawn the same on the
 * board tile and every list row.
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
  if (holdup.kind === "prerequisites") return <PrerequisiteHoldup task={task} className={className} labeled={labeled} />;
  const label = t(`backlog.statuses.${task.status}`);
  const text = holdup.text ?? t(holdup.kind === "blocked" ? "blocker.no_reason" : "blocker.no_question");
  return <HoldupDisclosure task={task} className={className} labeled={labeled} label={label} text={text} kind={holdup.kind} missing={!holdup.text} />;
}

/** Waiting on prerequisites: named by ref, from the task list the row came
 *  from — read from the cache, not subscribed, since the row re-renders
 *  with that list anyway. */
function PrerequisiteHoldup({ task, className, labeled }: {
  task: RelayTaskListItem;
  className?: string;
  labeled: boolean;
}) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const cached = queryClient.getQueryData<RelayTaskSummary[]>(TASKS_QUERY_KEY) ?? [];
  const tasks = new Map(cached.map((item) => [item.id, item]));
  const label = t("blocker.waiting_on_label");
  const text = t("blocker.waiting_on", { tasks: waitingOnRefs(task, tasks).join(", ") });
  return <HoldupDisclosure task={task} className={className} labeled={labeled} label={label} text={text} kind="prerequisites" />;
}

function HoldupDisclosure({ task, className, labeled, label, text, kind, missing = false }: {
  task: RelayTaskListItem;
  className?: string;
  labeled: boolean;
  label: string;
  text: string;
  kind: string;
  missing?: boolean;
}) {
  return (
    <Popover>
      <PopoverTrigger
        className={cn("task-holdup", className)}
        data-kind={kind}
        aria-label={`${label}: ${text}`}
        onClick={(event) => event.stopPropagation()}
      >
        <TaskStatusIcon status={task.status} />
        {labeled ? <span className="task-holdup-label">{label}</span> : null}
        <span className={cn("task-holdup-text", missing && "task-holdup-text--none")}>{text}</span>
      </PopoverTrigger>
      <PopoverContent align="start" className="task-holdup-popover" onClick={(event) => event.stopPropagation()}>
        <PopoverTitle>{label}</PopoverTitle>
        <PopoverDescription className="whitespace-pre-wrap break-words">{text}</PopoverDescription>
      </PopoverContent>
    </Popover>
  );
}
