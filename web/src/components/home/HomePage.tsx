"use client";

import { useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { PageHeader } from "../PageHeader";
import { useMinuteClock } from "../../hooks/useMinuteClock";
import { useUserAgents } from "../../hooks/useUserAgents";
import { hrefForRoute, navigateToAppPath, pathForAppState } from "../../lib/appRoute";
import { computerName } from "../../lib/createAgent";
import { labelForExecutor } from "../../lib/agentDisplayNames";
import { homeNeedsYouCount, type HomeItem } from "../../lib/homeQueue";
import { homeProjects, myTaskCounts, recentlyFinished, runningNow, type HomeProjectRow, type RunningRow } from "../../lib/homeSummary";
import { taskRef } from "../../lib/taskRef";
import { formatThreadStamp } from "../../lib/threadStamp";
import { greetingName, greetingPeriod } from "../../lib/welcomeRecap";
import type { AgentName } from "relay-core";
import type { CurrentUser, DaemonNodeMonitorRecord, ProjectRecord, RelaySession, RelayTaskListItem } from "../../types";
import { HomeQueue } from "./HomeQueue";
import { FinishedPanel, MyTasksPanel, ProjectsPanel, RunningPanel } from "./HomePanels";
import { useHomeActions } from "./useHomeActions";

export interface HomePageProps {
  user: CurrentUser;
  /** The owner key tasks and threads carry — the shell's selected user. */
  userId: string;
  setUser: (user: CurrentUser) => void;
  items: readonly HomeItem[];
  tasks: readonly RelayTaskListItem[];
  sessions: readonly RelaySession[];
  projects: readonly ProjectRecord[];
  nodes: readonly DaemonNodeMonitorRecord[];
  onOpenThread: (sessionId: string, replace?: boolean, parentTaskId?: string) => void;
  onOpenTaskRecord: (taskId: string | null) => void;
}

const threadPath = (sessionId: string) => hrefForRoute("main", sessionId);
const taskPath = (taskId: string) => pathForAppState({ route: "backlog", mobileView: "chat", sessionId: null, taskId });
const projectPath = (projectId: string) => pathForAppState({ route: "projects", mobileView: "threads", sessionId: null, projectId });
const tasksPath = (search = "") => `${hrefForRoute("backlog")}${search}`;

/** Home: what needs the signed-in person, ranked, beside where their work
 *  stands. The queue is computed once by the app shell (it also feeds the
 *  rail's badge) and arrives here as `items`. */
export function HomePage({ user, userId, setUser, items, tasks, sessions, projects, nodes, onOpenThread, onOpenTaskRecord }: HomePageProps) {
  const { t, i18n } = useTranslation();
  const now = useMinuteClock();
  const actions = useHomeActions(setUser);
  const { agents } = useUserAgents(user.userId);

  const agentNames = useMemo(() => new Map(agents.map((agent) => [agent.id, agent.displayName])), [agents]);
  const projectNames = useMemo(() => new Map(projects.map((project) => [project.id, project.name])), [projects]);
  const nodesById = useMemo(() => new Map(nodes.map((node) => [node.id, node])), [nodes]);
  const counts = useMemo(() => myTaskCounts(tasks, userId, now), [now, tasks, userId]);
  const projectRows = useMemo(() => homeProjects(projects, tasks, items), [items, projects, tasks]);
  const running = useMemo(() => runningNow(sessions, nodes, userId), [nodes, sessions, userId]);
  const finished = useMemo(() => recentlyFinished(tasks, userId), [tasks, userId]);

  const locale = i18n.resolvedLanguage ?? "en";
  const sinceLabel = useCallback((iso: string) => formatThreadStamp(iso, locale, now), [locale, now]);
  const agentName = useCallback((agentId: string | undefined, executor?: string) => {
    const named = agentId ? agentNames.get(agentId) : undefined;
    if (named) return named;
    return executor ? labelForExecutor(executor as AgentName) : null;
  }, [agentNames]);
  const projectName = useCallback((projectId: string | undefined) => (projectId ? projectNames.get(projectId) ?? null : null), [projectNames]);

  const hrefFor = useCallback((item: HomeItem): string => {
    switch (item.kind) {
      case "permission":
      case "suggested":
        return threadPath(item.session.id);
      case "wait":
        return item.awaiting.sessionId ? threadPath(item.awaiting.sessionId) : taskPath(item.task.id);
      case "offline":
        return hrefForRoute("computers");
      case "untriaged":
        return tasksPath("?queue=untriaged");
      default:
        return taskPath(item.task.id);
    }
  }, []);
  const openItem = useCallback((item: HomeItem) => {
    switch (item.kind) {
      case "permission":
      case "suggested":
        return onOpenThread(item.session.id);
      case "wait":
        return item.awaiting.sessionId ? onOpenThread(item.awaiting.sessionId, false, item.task.id) : onOpenTaskRecord(item.task.id);
      case "offline":
      case "untriaged":
        return void navigateToAppPath(hrefFor(item));
      default:
        return onOpenTaskRecord(item.task.id);
    }
  }, [hrefFor, onOpenTaskRecord, onOpenThread]);

  const needs = homeNeedsYouCount(items);
  const paused = items.filter((item) => item.tier === "paused").length;
  const stuck = items.filter((item) => item.tier === "stuck").length;
  const name = greetingName(user);
  const summary = [
    needs ? t("home.brief.needs", { count: needs }) : t("home.brief.clear"),
    ...(paused ? [t("home.brief.paused", { count: paused })] : []),
    t("home.brief.running", { count: running.length }),
    ...(stuck ? [t("home.brief.stuck", { count: stuck })] : []),
  ].join(" · ");

  const nextLabel = (row: HomeProjectRow): string => {
    if (row.next) return t("home.project_next", { what: nextSummary(row.next, t) });
    if (row.total > 0 && row.stages.done === row.total) return t("home.project_all_done");
    if (row.stages.running) return t("home.project_running", { count: row.stages.running });
    return t("home.project_quiet");
  };
  const runTitle = (row: RunningRow) => row.session.title || row.session.taskGoal || t("home.untitled_thread");
  const runComputer = (row: RunningRow) => {
    const node = row.computerId ? nodesById.get(row.computerId) : undefined;
    return node ? computerName(node) : null;
  };
  const runAgent = (row: RunningRow) => agentName(row.agentId);

  return (
    <section id="home-panel" className="home-page" aria-labelledby="home-title" tabIndex={-1}>
      <PageHeader
        title={<span id="home-title">{t(`transcript.welcome_greeting_${greetingPeriod(new Date(now).getHours())}`, { name })}</span>}
        topbarTitle={t("nav.home")}
        titleVariant="title"
        subtitle={<span className="home-brief">{summary}</span>}
      />
      <div className="home-body">
        <div className="home-grid">
          <div className="home-column">
            <HomeQueue
              items={items}
              actions={actions}
              agentName={agentName}
              projectName={projectName}
              sinceLabel={sinceLabel}
              hrefFor={hrefFor}
              onOpen={openItem}
              allTasksHref={tasksPath("?queue=needs_me")}
              onOpenAllTasks={() => void navigateToAppPath(tasksPath("?queue=needs_me"))}
            />
            <RunningPanel
              rows={running}
              title={runTitle}
              agentName={runAgent}
              computerName={runComputer}
              elapsed={sinceLabel}
              hrefFor={(row) => threadPath(row.session.id)}
              onOpen={(row) => onOpenThread(row.session.id)}
              allHref={hrefForRoute("main")}
              onOpenAll={() => void navigateToAppPath(hrefForRoute("main"))}
            />
          </div>
          <div className="home-column">
            <MyTasksPanel
              counts={counts}
            />
            <ProjectsPanel
              rows={projectRows}
              nextLabel={nextLabel}
              hrefFor={(row) => projectPath(row.project.id)}
              onOpen={(row) => void navigateToAppPath(projectPath(row.project.id))}
              allHref={hrefForRoute("projects")}
              onOpenAll={() => void navigateToAppPath(hrefForRoute("projects"))}
              onNewProject={() => void navigateToAppPath(hrefForRoute("projects"))}
            />
            <FinishedPanel
              tasks={finished}
              sinceLabel={sinceLabel}
              hrefFor={(task) => taskPath(task.id)}
              onOpen={(task) => onOpenTaskRecord(task.id)}
            />
          </div>
        </div>
      </div>
    </section>
  );
}

type T = (key: string, options?: Record<string, unknown>) => string;

/** A project row's "Next:" line, phrased from its first queue item. */
function nextSummary(item: HomeItem, t: T): string {
  switch (item.kind) {
    case "permission":
      return t("home.next.permission");
    case "wait":
      return t(`home.next.${item.awaiting.kind}`);
    case "suggested":
      return t("home.next.suggested");
    case "offline":
    case "untriaged":
      return t(`home.next.${item.kind}`);
    default:
      return t(`home.next.${item.kind}`, { ref: taskRef(item.task) });
  }
}
