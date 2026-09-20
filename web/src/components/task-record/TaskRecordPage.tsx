"use client";

import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { useUrlSearchState } from "../../hooks/useUrlSearchState";
import { pathForAppState } from "../../lib/appRoute";
import { navigateRecordBack, recordBackHref } from "../../lib/recordBack";
import type { RelayTaskListItem } from "../../types";
import { PageHeader } from "../PageHeader";
import { RecordBand, type RecordFact } from "../workspace/RecordBand";
import { recordBandFacts } from "./recordBandFacts";
import { TaskRecoveryPanel } from "../ExecutionRecoveryPanel";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { RecordArtifacts } from "./RecordArtifacts";
import { RecordHistory } from "./RecordHistory";
import { RecordResultLine } from "./RecordResultLine";
import { RecordRuns } from "./RecordRuns";
import { RecordWorkspace } from "./RecordWorkspace";
import { TaskRecordActions } from "./TaskRecordActions";
import type { RecordAction } from "./recordActions";
import { TaskRecordDefinition } from "./TaskRecordDefinition";
import {
  defaultRecordTab,
  parseRecordTab,
  recordTabs,
  recordVariant,
  type RecordTab,
} from "./recordVocabulary";

/**
 * One task or routine, as a record.
 *
 * This is the surface that replaced a drawer which was a definition form and
 * an execution log at once — a routine's runs happen in other entities, so
 * half the drawer described something the other half could not edit, under a
 * single Save button, at an address that did not exist.
 *
 * Three routes render this component: `/backlog/<id>`, `/routines/<id>`, and
 * `/routines/<id>/runs/<occurrenceId>`. The third works because an occurrence
 * IS a task — the run view is this component under a routine breadcrumb, not
 * a fourth surface.
 *
 * Two presentations: "page" takes the whole route (the backlog board), while
 * "drawer" (the routines board) drops the page header — the drawer's own
 * chrome carries the kicker, title, and close — and keeps the tabs, actions,
 * band, and body.
 *
 * Everything that differs between the two vocabularies is a value in
 * `recordVocabulary.ts`. A branch on `isRoutine` inside a tab panel means the
 * difference belongs there instead.
 */
export function TaskRecordPage({
  task,
  runningRoutineIds,
  parentRoutine,
  busyAction,
  presentation = "page",
  onOpenThread,
  onOpenRun,
  onRun,
  onCancel,
  onEdit,
  onDelete,
}: {
  task: RelayTaskListItem;
  /** Routines with a live occurrence — the one state a routine cannot derive alone. */
  runningRoutineIds: ReadonlySet<string>;
  /** Set when this record is open as one of a routine's runs. */
  parentRoutine?: { id: string; title: string };
  busyAction: RecordAction | null;
  /** "drawer" drops the page header; the surrounding drawer carries it. */
  presentation?: "page" | "drawer";
  onOpenThread: (sessionId: string) => void;
  onOpenRun: (runTaskId: string) => void;
  onRun: () => void;
  onCancel: () => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const { t, i18n } = useTranslation();
  const variant = recordVariant(task);
  const tabs = recordTabs(variant);
  const fallbackTab = defaultRecordTab(variant);
  const [tab, setTab] = useUrlSearchState<RecordTab>(
    "tab",
    fallbackTab,
    (value) => parseRecordTab(value, variant),
    (value) => (value === fallbackTab ? null : value),
    "push",
  );

  const facts = useMemo<RecordFact[]>(
    () => recordBandFacts(task, variant, runningRoutineIds, i18n.language, t),
    [task, variant, runningRoutineIds, i18n.language, t],
  );

  const listPath = pathForAppState({
    route: variant === "routine" ? "routine" : "backlog",
    mobileView: "chat",
    sessionId: null,
  });
  // A run belongs to its routine, not to the backlog it happens to sit in.
  const backHref = parentRoutine
    ? pathForAppState({ route: "routine", mobileView: "chat", sessionId: null, taskId: parentRoutine.id })
    : recordBackHref(listPath);
  const backLabel = parentRoutine ? parentRoutine.title : t(variant === "routine" ? "nav.routine" : "nav.backlog");

  const drawer = presentation === "drawer";
  const tabsList = (
    <TabsList className="workspace-page-tabs" aria-label={t("record.sections")}>
      {tabs.map((item) => (
        <TabsTrigger
          key={item}
          value={item}
          className={`workspace-page-tab${tab === item ? " is-active" : ""}`}
        >
          {t(`record.tab_${item}`)}
        </TabsTrigger>
      ))}
    </TabsList>
  );
  const actions = (
    <TaskRecordActions
      task={task}
      variant={variant}
      busyAction={busyAction}
      onRun={onRun}
      onCancel={onCancel}
      onEdit={onEdit}
      onDelete={onDelete}
    />
  );

  return (
    <Tabs
      render={<section id="task-record-panel" tabIndex={-1} />}
      className={drawer ? "workspace-page record-drawer" : "workspace-page"}
      aria-label={t("record.detail_label", { title: task.title })}
      value={tab}
      onValueChange={(value) => setTab(value as RecordTab)}
    >
      {drawer ? (
        /* The drawer chrome already named the record; this row is the
           sections and what can be done about them. */
        <div className="record-drawer-toolbar">
          {tabsList}
          {actions}
        </div>
      ) : (
        <PageHeader
          kicker={(
            <a
              className="record-back"
              href={backHref}
              onClick={(event) => {
                if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.altKey || event.ctrlKey || event.shiftKey) return;
                event.preventDefault();
                if (parentRoutine) {
                  onOpenRun(parentRoutine.id);
                  return;
                }
                navigateRecordBack(listPath);
              }}
            >
              {backLabel}
            </a>
          )}
          title={recordTitle(task, parentRoutine, i18n.language, t)}
          titleVariant="record"
          titleAs="h2"
          layout="stacked"
          toolbar={tabsList}
          actions={actions}
        />
      )}

      <RecordBand facts={facts} label={t("record.record_label")} />

      <div className="workspace-body">
        {variant === "routine" ? (
          <TabsContent value="runs">
            <RecordRuns
              taskId={task.id}
              hrefForRun={(runTaskId) => pathForAppState({
                route: "routine",
                mobileView: "chat",
                sessionId: null,
                taskId: task.id,
                runId: runTaskId,
              })}
              onOpenRun={onOpenRun}
            />
          </TabsContent>
        ) : (
          <TabsContent value="activity">
            {/* Why a run is stuck, and what to do about it, before the trace
                of how it got there. */}
            <TaskRecoveryPanel task={task} onOpenThread={onOpenThread} />
            <RecordResultLine taskId={task.id} onOpenThread={onOpenThread} />
            <RecordHistory taskId={task.id} onOpenThread={onOpenThread} />
          </TabsContent>
        )}
        <TabsContent value="definition">
          <TaskRecordDefinition task={task} variant={variant} locale={i18n.language} />
        </TabsContent>
        <TabsContent value="files">
          {/* The durable record first, then what is in the workspace now. */}
          <RecordArtifacts taskId={task.id} />
          <RecordWorkspace taskId={task.id} />
        </TabsContent>
      </div>
    </Tabs>
  );
}

/**
 * A run carries its routine's title, so a run page and its routine page would
 * otherwise be two records with one name. The date it was scheduled for is
 * what tells them apart.
 */
export function recordTitle(
  task: RelayTaskListItem,
  parentRoutine: { id: string; title: string } | undefined,
  locale: string,
  t: (key: string, options?: Record<string, unknown>) => string,
): string {
  if (!parentRoutine) return task.title;
  const when = task.scheduledFor ?? task.createdAt;
  const date = new Date(when);
  const label = Number.isNaN(date.getTime())
    ? when
    : new Intl.DateTimeFormat(locale || undefined, { month: "short", day: "numeric" }).format(date);
  return t("record.run_of", { date: label });
}
