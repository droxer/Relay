"use client";

import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Drawer } from "@/components/ui/Drawer";
import type { RelaySession, RelayTaskListItem } from "../../types";
import {
  ActionApprove,
  ActionStart,
  ActionStop,
  ICON,
  NavAgents,
  NavRefresh,
} from "../icons";
import { taskResultLine } from "../../lib/taskResult";
import { PriorityBadge } from "../PriorityBadge";
import { RecordBand } from "../workspace/RecordBand";
import { recordBandFacts } from "../task-record/recordBandFacts";
import { RoutineOriginBadge } from "./RoutineOriginBadge";
import { TaskFlowDetails, hrefForTaskRecord } from "./BacklogRecords";

/* The peek: everything the tile gave up, one click deep. The board card is a
   title and a facts line; this drawer is where the description, the exception
   line, the provenance, the outcome, and the actions went. It is a READ
   surface — editing lives in TaskDrawer, one layer up, so the peek holds no
   form fields of its own.

   Two sharing rules keep the peek honest:

   1. The facts come from `recordBandFacts`, the same builder the record page
      prints, so the peek and the record cannot disagree about status, date,
      assignee, or ref.
   2. The exception line is `TaskFlowDetails`, the same renderer the list row
      uses, fed by the same `taskExceptions` derivation. */

/** `recordBandFacts` asks for running routine ids; a backlog task never is one. */
const NO_RUNNING_ROUTINES: ReadonlySet<string> = new Set();

export function TaskPeekDrawer({
  open,
  task,
  session,
  routineTitle,
  canDiscuss,
  starting,
  onClose,
  onClosed,
  onOpenRecord,
  onEdit,
  onAssign,
  onStart,
  onToggleBlock,
  onDone,
}: {
  open: boolean;
  task: RelayTaskListItem;
  session?: RelaySession;
  /** Title of the routine this task was promoted from, when it was. */
  routineTitle?: string;
  canDiscuss: boolean;
  starting: boolean;
  onClose: () => void;
  /** Fires after the exit animation completes — release the peeked task here. */
  onClosed?: () => void;
  /** Opens the task's full record page. */
  onOpenRecord: () => void;
  onEdit: () => void;
  onAssign: () => void;
  onStart: () => void;
  onToggleBlock: () => void;
  onDone: () => void;
}) {
  const { t, i18n } = useTranslation();
  const facts = recordBandFacts(task, "task", NO_RUNNING_ROUTINES, i18n.language, t);
  const result = taskResultLine(task, session);
  const startDisabled =
    (!task.assignedAgentId && !task.assignedTeamId && !canDiscuss) ||
    task.status === "running" ||
    task.status === "done";

  return (
    <Drawer
      open={open}
      onClose={onClose}
      onClosed={onClosed}
      title={task.title}
      width="detail"
      closeLabel={t("drawer.close")}
      bodyClassName="adm-drawer-body--column"
    >
      <RecordBand facts={facts} label={t("record.record_label")} />
      <TaskFlowDetails task={task} execution={session?.execution} />
      {task.description ? <p className="task-peek-description">{task.description}</p> : null}
      {/* What the tile's facts line does not say: the routine this run came
          from and what the run left behind. */}
      <div className="task-peek-meta">
        <PriorityBadge priority={task.priority} />
        <RoutineOriginBadge task={task} routineTitle={routineTitle} />
        {result?.hasFiles ? (
          <span className="backlog-result-files tnum">
            {t("backlog.result_files", { count: result.fileCount })}
          </span>
        ) : null}
      </div>
      {/* The actions the card gave up. Four glyphs of one weight, labels in
          the tooltip — the same quiet `icon` tier and the same hover meanings
          (action for start, --err for block, --ok for done) the list rows
          use, and always visible: a drawer has no hover to reveal into. */}
      <div className="task-peek-actions">
        <div className="task-peek-action-groups">
          <div className="backlog-action-group" role="group" aria-label={t("backlog.actions_dispatch")}>
            <Button variant="icon"
              size="icon-dense"
              type="button"
              className="backlog-action-icon"
              onClick={onAssign}
              disabled={task.status === "running" || task.status === "done"}
              aria-label={t("backlog.assign_task")}
              title={t("backlog.assign_task")}
            >
              <NavAgents size={ICON.sm} />
            </Button>
            <Button variant="icon"
              size="icon-dense"
              tinted
              type="button"
              className="backlog-action-primary backlog-action-icon"
              onClick={onStart}
              disabled={startDisabled}
              loading={starting}
              aria-label={task.status === "blocked" ? t("backlog.retry") : ["review", "waiting_for_human"].includes(task.status) ? t("backlog.rework") : (task.assignedAgentId || task.assignedTeamId) ? t("backlog.start") : t("backlog.start_team")}
              title={task.status === "blocked" ? t("backlog.retry") : ["review", "waiting_for_human"].includes(task.status) ? t("backlog.rework") : (task.assignedAgentId || task.assignedTeamId) ? t("backlog.start") : t("backlog.start_team")}
            >
              <ActionStart size={ICON.sm} />
            </Button>
          </div>
          <div className="backlog-action-group" role="group" aria-label={t("backlog.actions_state")}>
            <Button variant="icon"
              size="icon-dense"
              type="button"
              className={cn("backlog-action-icon", task.status !== "blocked" && "backlog-action-block")}
              onClick={onToggleBlock}
              disabled={task.status === "running" || task.status === "done"}
              aria-label={task.status === "blocked" ? t("backlog.unblock") : t("backlog.block")}
              title={task.status === "blocked" ? t("backlog.unblock") : t("backlog.block")}
            >
              {task.status === "blocked" ? <NavRefresh size={ICON.sm} /> : <ActionStop size={ICON.sm} />}
            </Button>
            <Button variant="icon"
              size="icon-dense"
              type="button"
              className="backlog-action-icon backlog-action-done"
              onClick={onDone}
              disabled={task.status !== "review"}
              aria-label={t("backlog.done")}
              title={t("backlog.done")}
            >
              <ActionApprove size={ICON.sm} />
            </Button>
          </div>
        </div>
        <div className="task-peek-action-groups">
          <Button variant="ghost" size="dense" type="button" onClick={onEdit}>
            {t("record.edit")}
          </Button>
          {/* A real link, so a command-click reaches the record route without
              the peek in between; a plain click swaps surfaces in place. */}
          <a
            className="task-peek-open-record"
            href={hrefForTaskRecord(task.id)}
            onClick={(event) => {
              if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.altKey || event.ctrlKey || event.shiftKey) return;
              event.preventDefault();
              onOpenRecord();
            }}
          >
            {t("backlog.open_record")}
          </a>
        </div>
      </div>
    </Drawer>
  );
}
