"use client";

import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useUrlSearchState } from "../hooks/useUrlSearchState";
import { computerId as stableComputerId } from "../lib/createAgent";
import {
  DEFAULT_PROJECT_PAGE_TAB,
  parseProjectPageTab,
  projectReadOnly,
  PROJECT_PAGE_TABS,
  type ProjectPageTab,
} from "../lib/projectPage";
import { truncateId } from "../lib/adminHelpers";
import type {
  CurrentUser,
  DaemonNodeMonitorRecord,
  EmployeeAgent,
  ProjectMember,
  ProjectRecord,
  RelayTaskListItem,
} from "../types";
import { ICON, NavBack } from "./icons";
import { Badge } from "@/components/ui/badge";
import { PageHeader } from "./PageHeader";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ProjectMark } from "./ProjectMark";
import { ProjectMemberEditor } from "./ProjectMemberEditor";
import { ProjectMembersPanel } from "./ProjectMembersPanel";
import { ProjectSettingsPanel, type ProjectComputerSummary } from "./ProjectSettingsPanel";
import { ProjectWorkspaceFiles } from "./ProjectWorkspaceFiles";
import { RecordBand, type RecordFact } from "./workspace/RecordBand";
import { TonePill } from "./StatusPill";
import { Button } from "@/components/ui/button";
import { BacklogPage } from "./BacklogPage";
import { ProjectDashboard } from "./ProjectDashboard";
import { canonicalBrowserUrl, navigateToAppPath } from "../lib/appRoute";

/* The header's subtitle says what the open tab is for. It used to describe
   the tasks board on every tab, including the ones that are not it. */
const PROJECT_TAB_LABEL: Record<ProjectPageTab, string> = {
  dashboard: "project.dashboard_tab",
  members: "project.members_tab",
  tasks: "project.tasks_tab",
  workspace: "workspace.tab_workspace",
  settings: "project.settings_tab",
};

const PROJECT_TAB_SUBTITLE: Record<ProjectPageTab, string> = {
  dashboard: "project.dashboard_subtitle",
  members: "project.members_subtitle",
  tasks: "project.tasks_subtitle",
  workspace: "project.tasks_workspace_subtitle",
  settings: "project.settings_subtitle",
};

export function ProjectWorkspacePage({
  project,
  agents,
  tasks,
  currentUser,
  computers,
  onOpenThread,
  onDeleted,
  onBack,
}: {
  project: ProjectRecord;
  agents: EmployeeAgent[];
  /* The shell already polls the task list; a second observer on the same
     query key with its own interval polled the whole table twice over for
     one project's lanes. */
  tasks: RelayTaskListItem[];
  currentUser: CurrentUser;
  computers: DaemonNodeMonitorRecord[];
  onOpenThread: (sessionId: string) => void;
  onNewThread?: () => void;
  onDeleted: () => void;
  onBack: () => void;
}) {
  const { t } = useTranslation();
  const [memberEditor, setMemberEditor] = useState<{ member: ProjectMember | null } | null>(null);
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
  const pageTab: ProjectPageTab = recordTaskId ? "tasks" : urlTab;
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
  const computer = computers.find((node) => stableComputerId(node) === project.computerId);
  const computerLabel = computer?.displayName?.trim()
    || project.computerId.replace(/^device:[^:]+:/, "");
  const computerSummary: ProjectComputerSummary = {
    label: computerLabel,
    ownership: !computer ? "pending" : computer.managedNodeId?.trim() ? "managed" : "local",
  };
  const state = project.archivedAt ? "archived" : project.enabled ? "active" : "disabled";
  /* The title line carries the state and the id; the computer, folder and
     stamps live on the Settings tab with the rest of the record's facts. */
  const bandFacts: RecordFact[] = [
    {
      key: "state",
      label: t("project.band_state"),
      value: (
        <TonePill
          tone={state === "active" ? "good" : state === "disabled" ? "warn" : "neutral"}
          label={t(`project.state_${state}`)}
        />
      ),
    },
    {
      key: "id",
      label: t("project.band_id"),
      value: <Badge className="code" translate="no">{truncateId(project.id)}</Badge>,
      title: project.id,
    },
  ];

  /* Archived/disabled projects are read-only rooms — no member management. */
  const membersReadOnly = projectReadOnly(project);

  return (
    <Tabs
      render={<section id="project-detail-panel" tabIndex={-1} />}
      className="workspace-page project-workspace-page"
      aria-label={t("project.page_label", { project: project.name })}
      value={pageTab}
      onValueChange={(value) => setPageTab(value as ProjectPageTab)}
    >
      <PageHeader
        kicker={t("project.page_kicker")}
        /* The record's common facts ride the title line on every tab instead
           of claiming a band row above the tab body, so each panel keeps the
           full height under the header. */
        facts={<RecordBand facts={bandFacts} label={t("project.band_label")} variant="title" />}
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
          <>
            <Button type="button" variant="ghost" size="dense" className="project-mobile-back" onClick={onBack}>
              <NavBack size={ICON.sm} aria-hidden="true" />
              {t("project.back")}
            </Button>
          </>
        )}
        toolbar={(
          <TabsList className="workspace-page-tabs" aria-label={t("project.sections")}>
            {PROJECT_PAGE_TABS.map((tab) => (
              <TabsTrigger
                key={tab}
                value={tab}
                className={`workspace-page-tab${pageTab === tab ? " is-active" : ""}`}
              >
                {t(PROJECT_TAB_LABEL[tab])}
              </TabsTrigger>
            ))}
          </TabsList>
        )}
      />

      <div className="workspace-body">
        <TabsContent value="dashboard">
          <ProjectDashboard
            tasks={projectTasks}
            onOpenRecord={(taskId) => openTaskRecord(taskId)}
            onOpenBoard={() => setPageTab("tasks")}
          />
        </TabsContent>
        <TabsContent value="members">
          <ProjectMembersPanel
            project={project}
            agents={agents}
            onAddMember={membersReadOnly ? undefined : () => setMemberEditor({ member: null })}
            onEditMember={membersReadOnly ? undefined : (member) => setMemberEditor({ member })}
          />
        </TabsContent>
        <TabsContent value="tasks" className="project-tasks-panel">
          {/* The backlog board itself, fixed to this project. */}
          <BacklogPage
            key={project.id}
            readOnly={membersReadOnly}
            projectId={project.id}
            projects={[project]}
            tasks={projectTasks}
            nodes={computers}
            currentUser={currentUser}
            recordTaskId={recordTaskId}
            onOpenRecord={openTaskRecord}
            onOpenThread={(sessionId) => onOpenThread(sessionId)}
          />
        </TabsContent>
        <TabsContent value="workspace" className="workspace-inspect">
          <ProjectWorkspaceFiles projectId={project.id} />
        </TabsContent>
        <TabsContent value="settings">
          <ProjectSettingsPanel
            key={project.id}
            project={project}
            computer={computerSummary}
            onDeleted={onDeleted}
          />
        </TabsContent>
      </div>

      <ProjectMemberEditor
        open={memberEditor !== null}
        member={memberEditor?.member ?? null}
        project={project}
        agents={agents}
        computers={computers}
        onClose={() => setMemberEditor(null)}
      />

    </Tabs>
  );
}
