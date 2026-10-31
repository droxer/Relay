"use client";

import { lazy, memo, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { RelayEmptyState } from "./RelayEmptyState";
import type { CurrentUser, DaemonNodeMonitorRecord, ProjectRecord, RelaySession, RelayTaskSummary, UserAgent } from "../types";
import type { HomeItem } from "../lib/homeQueue";
import type { Language, Theme } from "../lib/appStorage";
import type { ProjectCollectionStatus } from "../lib/projectPage";
import type { AdminSection, AppRoute, MobileView, SettingsSection } from "../lib/viewTypes";

const HomePage = lazy(() => import("./home/HomePage").then((m) => ({ default: m.HomePage })));
const AdminPage = lazy(() => import("./AdminPage").then((m) => ({ default: m.AdminPage })));
const TasksWorkspace = lazy(() => import("./TasksWorkspace").then((m) => ({ default: m.TasksWorkspace })));
const ChannelsPage = lazy(() => import("./ChannelsPage").then((m) => ({ default: m.ChannelsPage })));
const RoutinesPage = lazy(() => import("./RoutinesPage").then((m) => ({ default: m.RoutinesPage })));
const AgentsPage = lazy(() => import("./AgentsPage").then((m) => ({ default: m.AgentsPage })));
const TeamsPage = lazy(() => import("./TeamsPage").then((m) => ({ default: m.TeamsPage })));
const ComputerPage = lazy(() => import("./ComputerPage").then((m) => ({ default: m.ComputerPage })));
const SkillsPage = lazy(() => import("./SkillsPage").then((m) => ({ default: m.SkillsPage })));
const SettingsPage = lazy(() => import("./SettingsPage").then((m) => ({ default: m.SettingsPage })));

const WORK_ROUTE_SKIP_IDS: Record<Exclude<AppRoute, "main" | "projects">, string> = {
  home: "home-panel",
  backlog: "backlog-panel",
  routine: "routine-panel",
  agents: "agents-panel",
  teams: "teams-panel",
  computers: "computer-panel",
  skills: "skills-panel",
  settings: "settings-panel",
  channels: "channels-panel",
  admin: "admin-panel",
};

/** Whether the content area shows a work page (or not-found) rather than
    the threads surface. A task's own thread stays in the threads surface. */
export function showsWorkRoutePage(route: AppRoute, notFound: boolean, taskThread: boolean): boolean {
  if (notFound) return true;
  if (route === "main" || route === "projects") return false;
  return !(route === "backlog" && taskThread);
}

/** Where the shell's skip link lands for the current route. */
export function skipLinkTarget({ route, mobileView, notFound, taskThread, projectOverview, agentId }: {
  route: AppRoute;
  mobileView: MobileView;
  notFound: boolean;
  taskThread: boolean;
  projectOverview: boolean;
  agentId: string | null;
}): string {
  if (notFound) return "#route-not-found";
  if (taskThread) return "#chat-panel";
  if (route === "projects" && projectOverview) return "#project-detail-panel";
  if (route === "main" || route === "projects") return mobileView === "threads" ? "#thread-panel" : "#chat-panel";
  if (route === "agents" && agentId) return "#agent-detail-panel";
  return `#${WORK_ROUTE_SKIP_IDS[route]}`;
}

interface WorkRoutePageProps {
  route: AppRoute;
  notFound: boolean;
  user: CurrentUser;
  projects: ProjectRecord[];
  projectsStatus: ProjectCollectionStatus;
  tasks: RelayTaskSummary[];
  sessions: RelaySession[];
  homeItems: HomeItem[];
  /** The owner key tasks and threads carry. */
  selectedUser: string;
  setUser: (user: CurrentUser) => void;
  visibleNodes: DaemonNodeMonitorRecord[];
  runtimeNodes: DaemonNodeMonitorRecord[];
  isRefreshing: boolean;
  onRefresh: () => Promise<void>;
  onOpenThread: (sessionId: string, replace?: boolean, parentTaskId?: string) => void;
  onGoHome: () => void;
  adminSection: AdminSection;
  onSelectAdminSection: (section: AdminSection) => void;
  recordTaskId: string | null;
  recordRunId: string | null;
  onOpenTaskRecord: (taskId: string | null) => void;
  onOpenRoutineRecord: (routineId: string | null, runId?: string | null) => void;
  teamWorkspaceId: string | null;
  onSelectTeam: (teamId: string | null) => void;
  detailAgent: UserAgent | null;
  onOpenAgent: (agentId: string | null) => void;
  settingsSection: SettingsSection;
  onSelectSettingsSection: (section: SettingsSection) => void;
  theme: Theme;
  onThemeChange: (theme: Theme) => void;
  language: Language;
  onLanguageChange: (language: Language) => void;
}

/** Every signed-in page that is not the threads surface, plus not-found.
    Each page is its own lazy chunk; the caller provides the Suspense and
    error boundaries. Memoized: the shell re-renders on every streamed frame
    of a run, and none of these pages shows that run — so every prop the
    caller passes must keep its identity between frames. */
export const WorkRoutePage = memo(function WorkRoutePage(props: WorkRoutePageProps) {
  const { t } = useTranslation();
  const { route, user, onOpenThread, onOpenAgent } = props;
  const openTaskThread = useCallback(
    (sessionId: string, taskId?: string) => onOpenThread(sessionId, false, taskId),
    [onOpenThread],
  );
  const openAgent = useCallback((agent: UserAgent) => onOpenAgent(agent.id), [onOpenAgent]);
  const backToAgents = useCallback(() => onOpenAgent(null), [onOpenAgent]);
  if (props.notFound) {
    return (
      // Fills the content tracks (not the rail column it used to fall
      // into), is the skip link's target, and offers a way back — it was a
      // bare English line with nowhere to go.
      <div id="route-not-found" className="route-not-found" tabIndex={-1}>
        <RelayEmptyState
          fill
          titleId="route-not-found-title"
          headingLevel={1}
          title={t("route_not_found.title")}
          body={t("route_not_found.body")}
          actions={(
            <Button type="button" variant="outline" size="dense" onClick={props.onGoHome}>
              {t("route_not_found.home")}
            </Button>
          )}
        />
      </div>
    );
  }
  return route === "home" ? (
    <HomePage
      user={user}
      userId={props.selectedUser}
      setUser={props.setUser}
      items={props.homeItems}
      tasks={props.tasks}
      sessions={props.sessions}
      projects={props.projects}
      nodes={props.runtimeNodes}
      onOpenThread={onOpenThread}
      onOpenTaskRecord={props.onOpenTaskRecord}
    />
  ) : route === "admin" ? (
    <AdminPage
      currentUser={user}
      section={props.adminSection}
      onSelectSection={props.onSelectAdminSection}
    />
  ) : route === "channels" ? <ChannelsPage /> : route === "backlog" ? (
    <TasksWorkspace
      projects={props.projects}
      projectsStatus={props.projectsStatus}
      recordTaskId={props.recordTaskId}
      onOpenRecord={props.onOpenTaskRecord}
      tasks={props.tasks}
      nodes={props.visibleNodes}
      currentUser={user}
      isRefreshing={props.isRefreshing}
      onRefresh={props.onRefresh}
      onOpenThread={openTaskThread}
    />
  ) : route === "routine" ? (
    <RoutinesPage
      projects={props.projects}
      recordTaskId={props.recordTaskId}
      recordRunId={props.recordRunId}
      onOpenRecord={props.onOpenRoutineRecord}
      tasks={props.tasks}
      nodes={props.visibleNodes}
      currentUser={user}
      isRefreshing={props.isRefreshing}
      onRefresh={props.onRefresh}
      onOpenThread={onOpenThread}
    />
  ) : route === "teams" ? (
    <TeamsPage
      currentUser={user}
      onOpenThread={onOpenThread}
      teamId={props.teamWorkspaceId}
      onSelectTeam={props.onSelectTeam}
    />
  ) : route === "agents" ? (
    <AgentsPage
      currentUser={user}
      detailAgent={props.detailAgent}
      onOpenAgent={openAgent}
      onBackToAgents={backToAgents}
      onOpenThread={onOpenThread}
    />
  ) : route === "computers" ? (
    <ComputerPage nodes={props.runtimeNodes} currentUser={user} onOpenThread={onOpenThread} />
  ) : route === "skills" ? (
    <SkillsPage currentUser={user} />
  ) : route === "settings" ? (
    <SettingsPage
      section={props.settingsSection}
      onSelectSection={props.onSelectSettingsSection}
      theme={props.theme}
      onThemeChange={props.onThemeChange}
      language={props.language}
      onLanguageChange={props.onLanguageChange}
    />
  ) : null;
});
