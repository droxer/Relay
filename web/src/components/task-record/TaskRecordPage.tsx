"use client";

import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { useProjectLookup } from "../../hooks/useProjectLookup";
import { useUrlSearchState } from "../../hooks/useUrlSearchState";
import { recordHrefForLocation } from "../../lib/workspaceScope";
import { projectReadOnly } from "../../lib/projectPage";
import { navigateRecordBack, recordBackHref } from "../../lib/recordBack";
import type { CurrentUser, RelayTaskListItem } from "../../types";
import { PageHeader } from "../PageHeader";
import type { RecordFact } from "../workspace/RecordBand";
import { RecordLayout } from "../workspace/RecordLayout";
import { recordBandFacts } from "./recordBandFacts";
import { TaskRecoveryPanel } from "../ExecutionRecoveryPanel";
import { taskRecoveryReason } from "../../lib/executionRecovery";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { RecordArtifacts } from "./RecordArtifacts";
import { RecordHistory } from "./RecordHistory";
import { RecordResultLine } from "./RecordResultLine";
import { TaskReviewPanel } from "./TaskReviewPanel";
import { TaskWorkflowTimeline } from "./TaskWorkflowTimeline";
import { RecordRuns } from "./RecordRuns";
import { TaskRecordActions } from "./TaskRecordActions";
import { InlineAssignee, InlineDue, InlinePriority, InlineStatus } from "../task-board/InlineTaskFields";
import { useInlineTaskEdits } from "../../hooks/useInlineTaskEdits";
import { canManageAutomation, type RecordAction } from "./recordActions";
import { TaskRecordDefinition } from "./TaskRecordDefinition";
import { RecordPrerequisites } from "./RecordPrerequisites";
import { useUserAgents } from "../../hooks/useUserAgents";
import { useWorkflowName } from "../../hooks/useProjectWorkflows";
import { predefinedStyle, teamWorkflowName } from "../../lib/workflowSelection";
import { useTeams } from "../../hooks/useTeams";
import { taskAgentDisplayName, taskAssigneeLabel } from "../../lib/taskAssignment";
import type { HistoryNameResolver } from "./taskHistoryLabel";
import { AutomationPauseBanner } from "../task-board/AutomationPauseBanner";
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
 * Three routes render this component: `/backlog/<id>`, `/automations/<id>`, and
 * `/automations/<id>/runs/<occurrenceId>`. The third works because an occurrence
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
  currentUser,
  busyAction,
  executionThreadId,
  presentation = "page",
  tabSearchKey = "tab",
  hrefForRun,
  onOpenThread,
  onOpenRun,
  onRun,
  onResume,
  onCancel,
  onDone,
  onEdit,
  onDelete,
  tasks = [],
  loadPrerequisiteChoices = false,
  onOpenTask,
}: {
  task: RelayTaskListItem;
  /** The tasks the board loaded: a project task's prerequisite candidates. */
  tasks?: readonly RelayTaskListItem[];
  loadPrerequisiteChoices?: boolean;
  /** Open another task's record, for a prerequisite link. */
  onOpenTask?: (taskId: string) => void;
  /** Routines with a live occurrence — the one state a routine cannot derive alone. */
  runningRoutineIds: ReadonlySet<string>;
  /** Set when this record is open as one of a routine's runs. */
  parentRoutine?: { id: string; title: string };
  /** Who is looking — the band's assignee and the timeline's assignment names
      resolve through the directories this user can see. */
  currentUser: CurrentUser;
  busyAction: RecordAction | null;
  executionThreadId?: string;
  /** "drawer" drops the page header; the surrounding drawer carries it. */
  presentation?: "page" | "drawer";
  tabSearchKey?: "tab" | "recordTab";
  hrefForRun?: (runId: string) => string;
  onOpenThread: (sessionId: string) => void;
  onOpenRun: (runTaskId: string) => void;
  onRun: () => void;
  onResume: () => void;
  onCancel: () => void;
  onDone: () => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const { t, i18n } = useTranslation();
  const revision = `${task.status}:${task.updatedAt}`;
  const variant = recordVariant(task);
  const tabs = recordTabs(variant);
  const fallbackTab = defaultRecordTab(variant);
  const [tab, setTab] = useUrlSearchState<RecordTab>(
    tabSearchKey,
    fallbackTab,
    (value) => parseRecordTab(value, variant),
    (value) => (value === fallbackTab ? null : value),
    "push",
  );

  /* A task opened from a project arrives with no other trace of it — the
     band is where that coordinate belongs. The same lookup answers whether
     the project is closed for work, which is what the actions below read. */
  const projectOf = useProjectLookup();
  const project = projectOf(task.projectId);
  const projectName = project?.name;
  const readOnly = projectReadOnly(project);
  const statusEdits = useInlineTaskEdits({ readOnly });
  /* The band names the assignee and the timeline names assignment targets;
     both resolve through the same directories the boards use. */
  const { teams, isSuccess: teamsReady, error: teamsError } = useTeams(currentUser.userId);
  const assignedTeam = teams.find((team) => team.id === task.assignedTeamId);
  const cachedWorkflowName = teamWorkflowName(assignedTeam, task.assignedWorkflowId);
  const fetchWorkflowName = Boolean(task.assignedWorkflowId) && !predefinedStyle(task.assignedWorkflowId)
    && !cachedWorkflowName && (!task.assignedTeamId || teamsReady || teamsError);
  const workflowName = useWorkflowName(fetchWorkflowName ? task.assignedWorkflowId : undefined, task.projectId);
  const { agents: logicalAgents } = useUserAgents(currentUser.userId);
  const historyNames = useMemo<HistoryNameResolver>(() => ({
    teamName: (teamId) => teams.find((team) => team.id === teamId)?.name,
    agentName: (agentId) => logicalAgents.find((agent) => agent.id === agentId)?.displayName,
    projectName: (projectId) => projectOf(projectId)?.name,
  }), [teams, logicalAgents, projectOf]);
  const assigneeAgent = task.assignedAgentId ? logicalAgents.find((agent) => agent.id === task.assignedAgentId) : undefined;
  const assigneeDisplay = {
    name: task.assignedWorkflowId && !task.assignedTeamId && !task.assignedAgentId
      ? (cachedWorkflowName ?? workflowName.data ?? undefined)
      : taskAgentDisplayName(task, logicalAgents, teams),
    imageUrl: assigneeAgent?.profileImageUrl ?? assignedTeam?.profileImageUrl ?? null,
    ready: assigneeAgent ? assigneeAgent.availability === "ready" : Boolean(assignedTeam?.enabled),
  };
  const assigneeName = taskAssigneeLabel(task, assigneeDisplay.name, t);
  const facts: RecordFact[] = recordBandFacts(
    task,
    variant,
    runningRoutineIds,
    i18n.language,
    t,
    task.projectId ? { id: task.projectId, name: projectName || task.projectId } : undefined,
    assigneeName,
    {
      /* Inline controls in the record sidebar eliminate extra Edit-drawer trips
         for everyday Status, Priority, Due, and Assignee changes. */
      status: (
        <InlineStatus
          task={task}
          labeled
          readOnly={!statusEdits}
          onChange={(status) => statusEdits?.changeStatus(task, status)}
          onToggleHold={() => { void statusEdits?.toggleHold(task); }}
        />
      ),
      priority: variant === "task" ? (
        <InlinePriority
          priority={task.priority}
          readOnly={!statusEdits}
          onChange={(priority) => statusEdits?.changePriority(task, priority)}
        />
      ) : undefined,
      due: variant === "task" && !task.scheduledFor ? (
        <InlineDue
          task={task}
          readOnly={!statusEdits}
          onChange={(dueDate) => statusEdits?.changeDue(task, dueDate)}
        />
      ) : undefined,
      assignee: variant === "task" ? (
        <InlineAssignee
          task={task}
          agents={logicalAgents}
          teams={teams}
          project={project}
          display={assigneeDisplay}
          readOnly={!statusEdits}
          onChange={(change) => statusEdits?.changeAssignment(task, change)}
        />
      ) : undefined,
    },
  );

  const listPath = recordHrefForLocation(variant === "routine" ? "routine" : "backlog", null);
  const backHref = parentRoutine ? recordHrefForLocation("routine", parentRoutine.id) : recordBackHref(listPath);
  const backLabel = parentRoutine ? parentRoutine.title : t(variant === "routine" ? "nav.routine" : "nav.backlog");

  const drawer = presentation === "drawer";
  const tabsList = (
    <TabsList className="workspace-page-tabs" stripKey={tab} aria-label={t("record.sections")}>
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
  const liveThreadId = executionThreadId ?? (task.status === "running" || task.attention?.code === "workflow_blocked"
    ? task.attention?.sessionId ?? task.linkedSessionIds.at(-1) : undefined);
  const actions = (
    <TaskRecordActions
      readingFile={tab === "artifacts"}
      task={task}
      readOnly={readOnly}
      busyAction={busyAction}
      canCancel={Boolean(executionThreadId)}
      automationRunning={runningRoutineIds.has(task.id)}
      onRun={onRun}
      onCancel={onCancel}
      onDone={onDone}
      onEdit={onEdit}
      onDelete={onDelete}
      onWatchLive={liveThreadId ? () => onOpenThread(liveThreadId) : undefined}
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
          {/* One cluster, held to the end of the row. Loose in the
              toolbar's space-between, each button claimed its own gap and
              the row read as four unrelated controls. */}
          <div className="record-drawer-actions">{actions}</div>
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

      <RecordLayout facts={facts} label={t("record.record_label")}>
      <div className="workspace-body">
        {variant === "routine" ? (
          <TabsContent value="runs" className="record-runs-panel">
            <AutomationPauseBanner
              task={task}
              className="record-automation-paused"
              onResume={!readOnly && canManageAutomation(task, currentUser) ? onResume : undefined}
              busy={busyAction !== null}
              resuming={busyAction === "resume"}
            />
            <RecordRuns
              taskId={task.id}
              hrefForRun={hrefForRun ?? ((runTaskId) => recordHrefForLocation("routine", task.id, runTaskId))}
              onOpenRun={onOpenRun}
              onOpenThread={onOpenThread}
            />
          </TabsContent>
        ) : (
          <TabsContent value="activity">
            {/* Review evidence lives on Activity (the default landing tab) so
                switching to Definition or Files isn't buried beneath it. */}
            {!task.isRoutine && (task.status === "review" || (task.verificationCheck && (task.status === "waiting_for_human" || task.status === "done"))) ? <TaskReviewPanel
              key={task.id}
              taskId={task.id}
              readOnly={readOnly || task.status !== "review"}
              onOpenThread={onOpenThread}
              onRequestChanges={() => { const threadId = task.linkedSessionIds.at(-1); if (threadId) onOpenThread(threadId); }}
            /> : null}
            {/* Why a run is stuck, and what to do about it, before the trace
                of how it got there. */}
            {task.status !== "review" && task.attention?.code !== "workflow_blocked" ? <TaskRecoveryPanel task={task} onOpenThread={onOpenThread} /> : null}
            <TaskWorkflowTimeline taskId={task.id} currentUserId={currentUser.userId} sessionIds={task.linkedSessionIds ?? []} agentName={id => historyNames.agentName?.(id) ?? id} agentImage={id => logicalAgents.find(agent => agent.id === id)?.profileImageUrl} onOpenThread={onOpenThread} />
            <RecordResultLine taskId={task.id} revision={revision} hideReason={Boolean(taskRecoveryReason(task))} onOpenThread={onOpenThread} />
            <RecordHistory taskId={task.id} revision={revision} live={task.status === "running"} names={historyNames} currentUserId={currentUser.userId} onOpenThread={onOpenThread} />
          </TabsContent>
        )}
        <TabsContent value="definition">
          <TaskRecordDefinition workflowLabel={cachedWorkflowName ?? workflowName.data ?? undefined} task={task} variant={variant} locale={i18n.language} team={assignedTeam} />
          {onOpenTask ? (
            <RecordPrerequisites task={task} tasks={tasks} readOnly={readOnly} onOpenTask={onOpenTask}
              loadChoices={loadPrerequisiteChoices} />
          ) : null}
        </TabsContent>
        {/* What the task's runs produced, listed beside a preview of the
            picked file — flush, like the routine's Runs tab, so the preview
            gets the drawer's full height. */}
        <TabsContent value="artifacts" className="record-artifacts-panel">
          <RecordArtifacts taskId={task.id} artifactsDir={task.workspaceArtifactsDir} revision={revision} />
        </TabsContent>
      </div>
      </RecordLayout>
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
