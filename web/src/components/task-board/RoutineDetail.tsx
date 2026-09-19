"use client";

import { type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { Button, buttonVariants } from "@/components/ui/button";
import { ICON, NavBack } from "../icons";
import { PageHeader } from "../PageHeader";
import { RecordBand, type RecordFact } from "../workspace/RecordBand";
import { TaskRecoveryPanel } from "../ExecutionRecoveryPanel";
import { TaskBoardForm } from "./TaskBoardForm";
import { RoutineAssignButton, RoutineStartButton } from "./RoutineRecords";
import { formatNextRunDate } from "./RoutineChrome";
import { taskRef } from "../../lib/taskRef";
import { hrefForRoute } from "../../lib/appRoute";
import type { RoutineTaskFormState, TaskBoardFormState } from "../../lib/taskBoardForm";
import type { RoutineState } from "../../lib/routine";
import type { AgentTeam, EmployeeAgent, RelaySession, RelayTaskListItem } from "../../types";

/* One routine, open. This is where a routine is read and edited now — the
   board stopped opening a drawer over itself for its own records.

   The fields are the shared TaskBoardForm, the same component the backlog's
   drawer mounts, so a routine's form cannot drift from a task's. What this
   adds is the record's identity: the RecordBand of read-only facts every
   record surface in the app prints under its header, the link to the thread
   its last run happened in, and the two dispatch actions. */

export function RoutineDetail({
  form,
  task,
  state,
  session,
  agentDisplayName,
  logicalAgents,
  teams,
  saving,
  deleting,
  starting,
  startDisabled,
  initialFocus,
  onChange,
  onSubmit,
  onDelete,
  onStart,
  onAssign,
  onBack,
  onOpenThread,
}: {
  form: RoutineTaskFormState;
  /** The saved record behind the form — absent while a routine is a draft. */
  task?: RelayTaskListItem;
  state?: RoutineState;
  session?: RelaySession;
  agentDisplayName?: string;
  logicalAgents: EmployeeAgent[];
  teams: AgentTeam[];
  saving: boolean;
  deleting: boolean;
  starting: boolean;
  startDisabled: boolean;
  initialFocus: "title" | "assignment";
  onChange: (next: TaskBoardFormState) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  onDelete?: () => void;
  onStart: () => void;
  onAssign: () => void;
  /** Returns to the board. On a phone the pane is the whole screen, so this is
   *  the only way back; on a desktop the rail is still beside it. */
  onBack: () => void;
  onOpenThread: (sessionId: string) => void;
}) {
  const { t } = useTranslation();

  /* Read-only facts, off the record the page already holds — no fetch, and
     nothing below may restate them (see RecordBand). The form's controls are
     not a restatement: the band prints what the routine IS, the fields are
     where it is changed. */
  const bandFacts: RecordFact[] = task && state ? [
    { key: "ref", label: t("backlog.col_ref"), value: taskRef(task.id), technical: true },
    { key: "state", label: t("routine.state"), value: t(`routine.states.${state}`) },
    { key: "cadence", label: t("routine.cadence"), value: t(`routine.cadences.${task.routineCadence ?? "weekly"}`) },
    {
      key: "next-run",
      label: t("routine.next_run"),
      value: task.routineNextRunDate ? formatNextRunDate(task.routineNextRunDate) : t("routine.no_next_run"),
    },
    ...(agentDisplayName
      ? [{ key: "agent", label: t("backlog.agent"), value: agentDisplayName }]
      : []),
  ] : [];

  return (
    <div className="routine-detail" id="routine-detail-panel" tabIndex={-1}>
      {/* Only reachable where the rail is off screen — see responsive.css. */}
      <Button
        type="button"
        variant="ghost"
        className="routine-mobile-back"
        onClick={onBack}
      >
        <NavBack size={ICON.sm} aria-hidden="true" />
        {t("routine.title")}
      </Button>

      <PageHeader
        title={task ? task.title : t("routine.new")}
        titleAs="h2"
        titleVariant={task ? "record" : "display"}
        layout="stacked"
        actions={task ? (
          <div className="backlog-action-group" role="group" aria-label={t("backlog.actions_dispatch")}>
            <RoutineAssignButton onAssign={onAssign} />
            <RoutineStartButton disabled={startDisabled} onStart={onStart} starting={starting} />
          </div>
        ) : undefined}
      />

      <RecordBand facts={bandFacts} label={t("routine.meta")} />

      <div className="routine-detail-body">
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
          meta={task ? (
            <>
              {/* The activity row below already links the latest run's thread. */}
              <TaskRecoveryPanel task={task} excludeSessionId={session?.id} onOpenThread={onOpenThread} />
              <div className="routine-detail-activity">
                <p className="task-drawer-meta-activity">
                  {task.lastActivity ? task.lastActivity.message : t("routine.no_activity")}
                </p>
                {session ? (
                  <a
                    data-slot="link-button"
                    href={hrefForRoute("main", session.id)}
                    className={buttonVariants({ variant: "ghost", size: "sm" })}
                    onClick={(event) => {
                      if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.altKey || event.ctrlKey || event.shiftKey) return;
                      event.preventDefault();
                      onOpenThread(session.id);
                    }}
                  >
                    {t("backlog.open_thread")}
                  </a>
                ) : null}
              </div>
            </>
          ) : undefined}
          onOpenThread={onOpenThread}
        />
      </div>
    </div>
  );
}
