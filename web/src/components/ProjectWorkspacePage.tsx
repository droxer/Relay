"use client";

import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useQuery } from "@tanstack/react-query";
import { listTasks, type TaskListCache } from "../api";
import { projectRecordOptions } from "../hooks/projectQueries";
import { useProjectLeadDiscussion } from "../hooks/useProjectLeadDiscussion";
import { useOwnAgentBadge, useUserAgents } from "../hooks/useUserAgents";
import { useUrlSearchState } from "../hooks/useUrlSearchState";
import { TASKS_QUERY_KEY } from "../hooks/useRelayData";
import { computerId as stableComputerId } from "../lib/createAgent";
import {
  DEFAULT_PROJECT_PAGE_TAB,
  parseProjectPageTab,
  projectBoardTasks,
  projectMemberState,
  projectReadOnly,
  PROJECT_PAGE_TABS,
  type ProjectPageTab,
} from "../lib/projectPage";
import type {
  CurrentUser,
  DaemonNodeMonitorRecord,
  UserAgent,
  ProjectMember,
  ProjectListItem,
  ProjectDashboardSummary,
  RelayTask,
  RelayTaskListItem,
  RelaySession,
} from "../types";
import { ICON, NavBack } from "./icons";
import { PageHeader } from "./PageHeader";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ProjectMark } from "./ProjectMark";
import { ProjectMemberEditor } from "./ProjectMemberEditor";
import { ProjectMembersPanel } from "./ProjectMembersPanel";
import { ProjectWorkflows } from "./workflow/ProjectWorkflows";
import { ProjectSettingsPanel, type ProjectComputerSummary } from "./ProjectSettingsPanel";
import { ProjectSetupPanel } from "./ProjectSetupPanel";
import { setupNeedsAttention } from "../lib/projectSetup";
import { ProjectWorkspaceFiles } from "./ProjectWorkspaceFiles";
import { RecordBand, type RecordFact } from "./workspace/RecordBand";
import { TonePill } from "./StatusPill";
import { Button } from "@/components/ui/button";
import { RoutinesPage } from "./RoutinesPage";
import { BacklogPage } from "./BacklogPage";
import { ProjectDashboard, ProjectTaskPlanning, ProjectTasksCreated } from "./ProjectDashboard";
import { ProjectContextSuggestions } from "./ProjectContextUpkeep";
import { ProjectManagerLine } from "./ProjectManagerLine";
import { ProjectDiscussionsPanel } from "./ProjectDiscussionsPanel";
import { canonicalBrowserUrl, navigateToAppPath } from "../lib/appRoute";
import { isProjectDirectoryEntry } from "../lib/projectDirectory";
import { RELAY_POLL_INTERVALS_MS } from "../lib/relayPolling";

/* The header's subtitle says what the open tab is for. It used to describe
   the tasks board on every tab, including the ones that are not it. */
const PROJECT_TAB_LABEL: Record<ProjectPageTab, string> = {
  dashboard: "project.dashboard_tab",
  members: "project.members_tab",
  tasks: "project.tasks_tab",
  discussions: "project.discussions_tab",
  automations: "routine.title",
  workspace: "workspace.tab_workspace",
  settings: "project.settings_tab",
};

const PROJECT_TAB_SUBTITLE: Record<ProjectPageTab, string> = {
  dashboard: "project.dashboard_subtitle",
  members: "project.members_subtitle",
  tasks: "project.tasks_subtitle",
  discussions: "project.discussions_subtitle",
  automations: "project.automations_subtitle",
  workspace: "project.tasks_workspace_subtitle",
  settings: "project.settings_subtitle",
};

export function ProjectWorkspacePage({
  project,
  agents,
  tasks,
  pageOwnsTasks = false,
  dashboard,
  currentUser,
  computers,
  onOpenThread,
  onNewThread,
  onRenameThread,
  onCloseThread,
  onDeleted,
  onBack,
}: {
  project: ProjectListItem;
  agents: UserAgent[];
  /** The shell supplies a legacy Dashboard fallback. */
  tasks: RelayTaskListItem[];
  pageOwnsTasks?: boolean;
  dashboard?: ProjectDashboardSummary;
  currentUser: CurrentUser;
  computers: DaemonNodeMonitorRecord[];
  onOpenThread: (sessionId: string) => void;
  onNewThread: (projectId: string) => void;
  onRenameThread: (session: RelaySession) => void;
  onCloseThread: (sessionId: string, title?: string) => void;
  onDeleted: () => void;
  onBack: () => void;
}) {
  const { t } = useTranslation();
  const [memberEditor, setMemberEditor] = useState<{ member: ProjectMember | null } | null>(null);
  const [createdTasks, setCreatedTasks] = useState<{ projectId: string; titles: string[] } | null>(null);
  /* The tab is always written explicitly and left to canonicalization to
     drop when it is implied: an open `?task=` implies Tasks, so a bare
     "dashboard" would otherwise read back as Tasks and keep the task open. */
  const [urlTab, setPageTab] = useUrlSearchState(
    "tab",
    DEFAULT_PROJECT_PAGE_TAB,
    parseProjectPageTab,
    (value) => value,
    "push",
  );
  /* A task record opens as a drawer over the project's board — the project
     stays the reader's place — and `?task=` keeps it addressable. */
  const [recordTaskId] = useUrlSearchState<string | null>(
    "task",
    null,
    (value) => value || null,
    (value) => value,
    "push",
  );
  const [automationId] = useUrlSearchState<string | null>("automation", null, (value) => value || null, (value) => value);
  const [automationRunId] = useUrlSearchState<string | null>("run", null, (value) => value || null, (value) => value);
  const openAutomationRecord = (taskId: string | null, runId?: string | null) => {
    const url = new URL(window.location.href);
    url.searchParams.set("tab", "automations");
    url.searchParams.delete("recordTab");
    if (taskId) url.searchParams.set("automation", taskId);
    else url.searchParams.delete("automation");
    if (taskId && runId) url.searchParams.set("run", runId);
    else url.searchParams.delete("run");
    void navigateToAppPath(canonicalBrowserUrl(url.pathname, url.search));
  };
  const pageTab: ProjectPageTab = recordTaskId ? "tasks" : urlTab;
  const directoryEntry = isProjectDirectoryEntry(project);
  const setup = directoryEntry ? project.setupSummary : project.setup;
  const membersReadOnly = projectReadOnly(project);
  const canPlan = !membersReadOnly && currentUser.userId === project.ownerUserId;
  const showingSetup = pageTab === "dashboard" && canPlan && setupNeedsAttention(setup);
  const { agents: setupAgents } = useUserAgents(currentUser.userId, true, showingSetup);
  const lead = useOwnAgentBadge(
    currentUser.userId, project.leadAgentId,
    (pageTab === "dashboard" && !showingSetup) || (pageTab === "discussions" && canPlan),
  );
  const dashboardAgents = showingSetup && setupAgents.length ? setupAgents : agents;
  const managerAgents = lead ? [lead] : dashboardAgents;
  const needsDashboardRecord = pageTab === "dashboard"
    && (Boolean(project.contextSummary?.suggestionCount) || (setupNeedsAttention(setup) && (directoryEntry || Boolean(project.contextSummary))));
  const needsPlanningRecord = pageTab === "dashboard" && canPlan && directoryEntry
    && (Boolean(project.leadAgentId) || dashboard?.metrics.total === 0 || (!pageOwnsTasks && tasks.length === 0));
  const needsProjectRecord = needsDashboardRecord
    || needsPlanningRecord
    || (pageTab === "members" && directoryEntry)
    || (pageTab === "settings" && (directoryEntry || Boolean(project.contextSummary)));
  const detail = useQuery({
    ...projectRecordOptions(project.id, project.version),
    enabled: needsProjectRecord,
  });
  const projectRecord = detail.data?.project ?? (needsProjectRecord || directoryEntry ? undefined : project);
  const detailStatus = detail.isError ? (
    <div className="route-loading" role="alert">
      {t("project.load_failed")}
      <Button variant="outline" onClick={() => void detail.refetch()}>{t("workspace.retry")}</Button>
    </div>
  ) : <div className="route-loading" role="status">{t("project.loading")}</div>;
  /* Opening or closing a record is one write that pins the Tasks tab, so
     closing it returns to the board rather than to the default tab, and the
     board's filters in the query string ride along untouched. */
  const openTaskRecord = (taskId: string | null) => {
    const url = new URL(window.location.href);
    url.searchParams.set("tab", "tasks");
    if (taskId) url.searchParams.set("task", taskId);
    else {
      url.searchParams.delete("task");
      url.searchParams.delete("recordTab");
    }
    void navigateToAppPath(canonicalBrowserUrl(url.pathname, url.search));
  };
  const projectTasks = useMemo(
    () => tasks.filter((task) => task.projectId === project.id && !task.deletedAt),
    [tasks, project.id],
  );
  const boardTasks = useMemo(() => projectBoardTasks(tasks, project.id), [tasks, project.id]);
  const metricsCache = useMemo<TaskListCache>(() => ({ projectId: project.id, scope: "project-dashboard" }), [project.id]);
  // The shell owns this query on Dashboard. Other tabs read the cached compact
  // result for the badge without adding an extra request on direct tab loads.
  const dashboardQuery = useQuery({
    queryKey: [...TASKS_QUERY_KEY, project.id, "project-dashboard"],
    queryFn: ({ signal }) => listTasks(signal, metricsCache),
    enabled: false,
    staleTime: RELAY_POLL_INTERVALS_MS.tasks,
  });
  const counts = dashboard ?? dashboardQuery.data?.projectDashboard;
  const openTaskCount = counts?.openTaskCount
    ?? (counts ? counts.metrics.total - counts.metrics.done
      : boardTasks.filter((task) => task.status !== "done" && task.status !== "cancelled").length);
  const onTasksCreated = (records: RelayTask[]) => {
    setCreatedTasks({ projectId: project.id, titles: records.map((task) => task.title) });
  };
  const viewCreatedTasks = () => {
    const url = new URL(window.location.href);
    const projectPath = `/projects/${encodeURIComponent(project.id)}`;
    if (url.pathname.replace(/\/$/u, "") === projectPath) {
      openTaskRecord(null);
    } else {
      void navigateToAppPath(canonicalBrowserUrl(projectPath, "?tab=tasks"));
    }
  };
  const computer = computers.find((node) => stableComputerId(node) === project.computerId);
  const computerLabel = computer?.displayName?.trim()
    || project.computerId.replace(/^device:[^:]+:/, "");
  const computerSummary: ProjectComputerSummary = {
    label: computerLabel,
    ownership: !computer ? "pending" : computer.managedNodeId?.trim() ? "managed" : "local",
  };
  const state = project.archivedAt ? "archived" : project.enabled ? "active" : "disabled";
  /* The title line names the state only when it is not the default: an
     active project needs no "Active" pill on every tab. The id, computer,
     folder and stamps live on the Settings tab with the record's facts. */
  const bandFacts: RecordFact[] = state === "active" ? [] : [
    {
      key: "state",
      label: t("project.band_state"),
      value: <TonePill tone={state === "disabled" ? "warn" : "neutral"} label={t(`project.state_${state}`)} />,
    },
  ];

  const leadDiscussion = useProjectLeadDiscussion({ projectId: project.id, currentUser, onOpenThread });
  /* Only the owner talks to the lead here (the conversation route is
     owner-scoped), and only while the project can take new work. */
  const canDiscuss = !membersReadOnly
    && Boolean(project.leadAgentId)
    && Boolean(currentUser.userId)
    && currentUser.userId === project.ownerUserId;
  const leadMember = project.members.find(member => member.agentId === project.leadAgentId);
  const leadAgent = lead === undefined ? agents.find(agent => agent.id === project.leadAgentId) : lead ?? undefined;
  const canDiscussWithLead = canDiscuss && leadMember && projectMemberState(leadMember, leadAgent).enabled;

  return (
    <Tabs
      render={<section id="project-detail-panel" tabIndex={-1} />}
      className="workspace-page project-workspace-page"
      aria-label={t("project.page_label", { project: project.name })}
      value={pageTab}
      onValueChange={(value) => setPageTab(value as ProjectPageTab)}
    >
      <PageHeader
        /* The record's common facts ride the title line on every tab instead
           of claiming a band row above the tab body, so each panel keeps the
           full height under the header. */
        facts={bandFacts.length > 0 ? <RecordBand facts={bandFacts} label={t("project.band_label")} variant="title" /> : undefined}
        title={(
          <span className="workspace-header-title">
            <span className="workspace-header-mark"><ProjectMark size={ICON.sm} /></span>
            {project.name}
          </span>
        )}
        subtitle={t(PROJECT_TAB_SUBTITLE[pageTab])}
        titleVariant="record"
        layout="stacked"
        actions={(
          <Button type="button" variant="ghost" size="dense" className="project-mobile-back" onClick={onBack}>
            <NavBack size={ICON.sm} aria-hidden="true" />
            {t("project.back")}
          </Button>
        )}
        toolbar={(
          <TabsList className="workspace-page-tabs" stripKey={pageTab} aria-label={t("project.sections")}>
            {PROJECT_PAGE_TABS.map((tab) => (
              <TabsTrigger
                key={tab}
                value={tab}
                className={`workspace-page-tab${pageTab === tab ? " is-active" : ""}`}
                aria-label={tab === "tasks" ? t(PROJECT_TAB_LABEL[tab]) : undefined}
                aria-description={tab === "tasks" && openTaskCount > 0 ? t("project.tasks_tab_open", { count: openTaskCount }) : undefined}
              >
                {t(PROJECT_TAB_LABEL[tab])}
                {tab === "tasks" && openTaskCount > 0 ? (
                  <span className="project-tasks-tab-count" aria-hidden="true">{openTaskCount}</span>
                ) : null}
              </TabsTrigger>
            ))}
          </TabsList>
        )}
      />

      <div className="workspace-body">
        <TabsContent value="dashboard">
          <ProjectDashboard
            confirmation={createdTasks?.projectId === project.id ? (
              <ProjectTasksCreated titles={createdTasks.titles} onOpenBoard={viewCreatedTasks} onDismiss={() => setCreatedTasks(null)} />
            ) : null}
            review={projectRecord && setupNeedsAttention(projectRecord.setup) && canPlan ? (
              <ProjectSetupPanel
                project={projectRecord}
                setup={projectRecord.setup}
                agents={dashboardAgents}
                onOpenThread={onOpenThread}
                onManual={() => setPageTab("members")}
                onTasksCreated={onTasksCreated}
                onViewTasks={viewCreatedTasks}
              />
            ) : null}
            planning={canPlan && !setupNeedsAttention(setup) && projectRecord && !setupNeedsAttention(projectRecord.setup)
              ? (empty) => (
                <ProjectTaskPlanning
                  key={project.id}
                  project={projectRecord}
                  empty={empty}
                  onAssignLead={() => setPageTab("members")}
                  onOpenBoard={() => setPageTab("tasks")}
                />
              ) : undefined}
            steward={(
              <ProjectManagerLine
                project={project}
                agents={managerAgents}
                onManage={membersReadOnly ? undefined : () => setPageTab("members")}
                onDiscuss={canDiscuss ? leadDiscussion.discuss : undefined}
                discussing={leadDiscussion.pending}
              />
            )}
            proposals={projectRecord
              ? <ProjectContextSuggestions project={projectRecord} readOnly={membersReadOnly} onOpenThread={onOpenThread} />
              : needsDashboardRecord || needsPlanningRecord ? detailStatus : null}
            tasks={boardTasks}
            summary={counts}
            onOpenRecord={(taskId) => openTaskRecord(taskId)}
            onOpenBoard={() => setPageTab("tasks")}
          />
        </TabsContent>
        <TabsContent value="members">
          <ProjectMembersPanel
            project={projectRecord ?? project}
            agents={agents}
            detailStatus={projectRecord ? undefined : detailStatus}
            onAddMember={membersReadOnly || !projectRecord ? undefined : () => setMemberEditor({ member: null })}
            onEditMember={membersReadOnly || !projectRecord ? undefined : (member) => setMemberEditor({ member })}
          >
            <ProjectWorkflows
              project={project}
              agents={agents}
              userId={currentUser.userId}
              readOnly={membersReadOnly}
              onOpenThread={onOpenThread}
            />
          </ProjectMembersPanel>
        </TabsContent>
        <TabsContent value="tasks" className="project-tasks-panel">
          {/* The backlog board itself, fixed to this project. */}
          <BacklogPage
            key={project.id}
            readOnly={membersReadOnly}
            projectId={project.id}
            projects={[project]}
            tasks={pageOwnsTasks ? undefined : boardTasks}
            nodes={computers}
            currentUser={currentUser}
            recordTaskId={recordTaskId}
            onOpenRecord={openTaskRecord}
            onOpenThread={(sessionId) => onOpenThread(sessionId)}
          />
        </TabsContent>
        <TabsContent value="discussions" className="project-profile project-discussions-panel">
          <ProjectDiscussionsPanel
            key={project.id}
            projectId={project.id}
            archived={Boolean(project.archivedAt)}
            agents={agents}
            computers={computers}
            onOpenThread={onOpenThread}
            onNewThread={canPlan ? () => onNewThread(project.id) : undefined}
            onRenameThread={onRenameThread}
            onCloseThread={onCloseThread}
            onDiscussWithLead={canDiscussWithLead ? leadDiscussion.discuss : undefined}
            discussing={leadDiscussion.pending}
          />
        </TabsContent>
        <TabsContent value="automations" className="project-tasks-panel">
          <RoutinesPage
            key={project.id}
            projectId={project.id}
            readOnly={membersReadOnly}
            projects={[project]}
            tasks={pageOwnsTasks ? undefined : projectTasks}
            nodes={computers}
            currentUser={currentUser}
            recordTaskId={automationId}
            recordRunId={automationRunId}
            onOpenRecord={openAutomationRecord}
            onOpenThread={onOpenThread}
          />
        </TabsContent>
        <TabsContent value="workspace" className="workspace-inspect">
          <ProjectWorkspaceFiles projectId={project.id} />
        </TabsContent>
        <TabsContent value="settings">
          {projectRecord ? (
            <ProjectSettingsPanel
              key={project.id}
              project={projectRecord}
              computer={computerSummary}
              onDeleted={onDeleted}
              onOpenThread={onOpenThread}
            />
          ) : detailStatus}
        </TabsContent>
      </div>

      {projectRecord ? <ProjectMemberEditor
        open={memberEditor !== null}
        member={memberEditor?.member ?? null}
        project={projectRecord}
        agents={agents}
        computers={computers}
        onClose={() => setMemberEditor(null)}
      /> : null}

    </Tabs>
  );
}
