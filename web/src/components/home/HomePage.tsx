"use client";

import { useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { useTeams } from "../../hooks/useTeams";
import { isUserAgentRoutable } from "../../lib/agentDisplayNames";
import { agentOnComputer, teamOnComputer, isTeamRoutable } from "../../lib/taskAssignment";
import { isoToday } from "../../lib/routine";
import { homeUpcoming, readyHomeTasks, homeBlockers, homeFocusItem } from "../../lib/homePlan";
import type { ProjectCollectionStatus } from "../../lib/projectPage";
import { ReadyTask, UpcomingPanel, BlockersPanel } from "./HomePlanningPanels";
import { PageHeader } from "../PageHeader";
import { useMinuteClock } from "../../hooks/useMinuteClock";
import { useUserAgents } from "../../hooks/useUserAgents";
import { hrefForRoute, navigateToAppPath, pathForAppState } from "../../lib/appRoute";
import { computerName, computerId } from "../../lib/createAgent";
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
  dataStatus: ProjectCollectionStatus;
  onRefresh: () => Promise<void>;
  onOpenRoutineRecord: (id: string, runId?: string) => void;
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
export function HomePage({ user, userId, setUser, items, tasks, sessions, projects, nodes, onOpenThread, onOpenTaskRecord, dataStatus, onRefresh, onOpenRoutineRecord }: HomePageProps) {
  const { t, i18n } = useTranslation();
  const now = useMinuteClock();
  const actions = useHomeActions(setUser);
  const { agents } = useUserAgents(user.userId);
  const { teams } = useTeams(user.userId);
  const today = isoToday(new Date(now));
  const [readyExpanded, setReadyExpanded] = useState(false);
  const upcoming = useMemo(() => homeUpcoming(tasks, userId, today), [tasks, userId, today]);
  const blockers = useMemo(() => homeBlockers(tasks, userId), [tasks, userId]);
  const ready = useMemo(() => readyHomeTasks(tasks, projects, userId).filter(task => {
    const project = projects.find(p => p.id === task.projectId)!;
    if (!nodes.some(n => computerId(n) === project.computerId && n.online && !n.stale && !n.retiredAt)) return false;
    if (task.assignedTeamId) {
      const team = teams.find(t => t.id === task.assignedTeamId);
      return Boolean(team && isTeamRoutable(team) && teamOnComputer(team, agents, project.computerId));
    }
    const agent = agents.find(a => a.id === task.assignedAgentId);
    return Boolean(agent && isUserAgentRoutable(agent) && agentOnComputer(agent, project.computerId));
  }), [tasks, projects, userId, nodes, agents, teams]);
  const readyFocus = !homeFocusItem(items) ? ready[0] : undefined;
  const readyRest = ready.filter(t => t.id !== readyFocus?.id);


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
  const name = greetingName(user);
  const summary = [
    { tone: needs ? "warn" : "ok", text: needs ? t("home.brief.needs", { count: needs }) : t("home.brief.clear") },
    { tone: running.length ? "live" : "neutral", text: t("home.brief.running", { count: running.length }) },
  ];

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
      <div className="home-body">
        <PageHeader
          title={<span id="home-title">{t(`transcript.welcome_greeting_${greetingPeriod(new Date(now).getHours())}`, { name })}</span>}
          titleVariant="display"
          layout="stacked"
          subtitle={dataStatus !== "ready" ? t(`home.plan.${dataStatus}`) : <span className="home-brief">{summary.map(({ tone, text }) => (
            <span key={text} className="home-brief-status" data-tone={tone}>
              <i aria-hidden="true" />{text}
            </span>
          ))}</span>}
        />
        {dataStatus !== "ready" ? (
          <div className="home-data-state" role={dataStatus === "error" ? "alert" : "status"}>
            <p>{t(dataStatus === "error" ? "home.plan.error_detail" : "home.plan.loading_detail")}</p>
            {dataStatus === "error" ? <Button variant="outline" onClick={() => void onRefresh()}>{t("home.plan.retry")}</Button> : <div className="home-loading-lines" aria-hidden="true"><i /><i /><i /></div>}
          </div>
        ) : <div className="home-grid">
          <div className="home-column">
            <HomeQueue
              items={items}
              contextLinks={<nav className="home-mobile-context" aria-label={t("home.plan.jump_to")}>
                {running.length ? <a href="#home-running-title">{t("home.plan.running_jump", {count:running.length})}</a> : null}
                <a href="#home-upcoming-title">{t("home.plan.upcoming_jump", {count:upcoming.length})}</a>
                {blockers.length ? <a href="#home-blockers-title">{t("home.plan.blockers_jump", {count:blockers.length})}</a> : null}
              </nav>}
              readyFocus={readyFocus ? <ReadyTask key={readyFocus.id} task={readyFocus} onStart={actions.startTask} href={taskPath(readyFocus.id)} onOpen={() => onOpenTaskRecord(readyFocus.id)} focus /> : undefined}
              actions={actions}
              agentName={agentName}
              projectName={projectName}
              sinceLabel={sinceLabel}
              hrefFor={hrefFor}
              onOpen={openItem}
              allTasksHref={tasksPath("?queue=needs_me")}
              onOpenAllTasks={() => void navigateToAppPath(tasksPath("?queue=needs_me"))}
            />
            <BlockersPanel rows={blockers} onOpenTask={onOpenTaskRecord} taskHref={taskPath} />
            {readyRest.length ? <section className="home-section" aria-labelledby="home-ready-title">
              <header className="home-section-header"><h2 id="home-ready-title" className="home-section-title">{t("home.plan.ready_work")}</h2><span className="home-section-count tnum">{readyRest.length}</span></header>
              <div className="home-panel">
                {(readyExpanded ? readyRest : readyRest.slice(0,3)).map(task => <ReadyTask key={task.id} task={task} onStart={actions.startTask} href={taskPath(task.id)} onOpen={() => onOpenTaskRecord(task.id)} />)}
                {readyRest.length > 3 ? <Button variant="ghost" size="dense" onClick={() => setReadyExpanded(!readyExpanded)}>{t(readyExpanded ? "home.plan.show_less" : "home.plan.show_all", {count:readyRest.length})}</Button> : null}
                <div className="home-panel-footer"><a className="home-link" href={tasksPath()} onClick={event => { if (event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey) { event.preventDefault(); navigateToAppPath(tasksPath()); } }}>{t("home.all_tasks")}</a></div>
              </div>
            </section> : null}
          </div>
          <div className="home-column">
            <MyTasksPanel
              counts={counts}
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
            <UpcomingPanel rows={upcoming} today={today}
              hrefFor={row => row.task.isRoutine ? pathForAppState({ route: "routine", mobileView: "chat", sessionId: null, taskId: row.task.id }) : taskPath(row.task.id)}
              onOpen={row => row.task.isRoutine ? onOpenRoutineRecord(row.task.id) : onOpenTaskRecord(row.task.id)} />
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
        </div>}
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
