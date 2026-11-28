"use client";

import { useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import type { HomeStatsPeriod } from "../../api-client/home";
import { useHomeStats } from "../../hooks/useHomeStats";
import { useProjectWorkflowChoices } from "../../hooks/useProjectWorkflows";
import { useTeams } from "../../hooks/useTeams";
import { isUserAgentRoutable } from "../../lib/agentDisplayNames";
import { agentOnComputer, teamOnComputer, isTeamRoutable } from "../../lib/taskAssignment";
import { isoToday } from "../../lib/routine";
import { homeUpcoming, readyHomeTasks, homeBlockers, homeFocusItem, homeProjectWorkflowReady } from "../../lib/homePlan";
import { predefinedStyle } from "../../lib/workflowSelection";
import type { ProjectCollectionStatus } from "../../lib/projectPage";
import { ReadyTask, ShowAllToggle, UpcomingPanel, BlockersPanel } from "./HomePlanningPanels";
import { ListSkeleton } from "../ListSkeleton";
import { formatRunDuration } from "../../lib/taskRuns";
import { PageHeader } from "../PageHeader";
import { useMinuteClock } from "../../hooks/useMinuteClock";
import { useUserAgents } from "../../hooks/useUserAgents";
import { hrefForRoute, navigateToAppPath, pathForAppState } from "../../lib/appRoute";
import { computerName, computerId } from "../../lib/createAgent";
import { labelForExecutor } from "../../lib/agentDisplayNames";
import type { HomeItem } from "../../lib/homeQueue";
import { homeProjects, recentlyFinished, runningNow, type HomeProjectRow, type RunningRow } from "../../lib/homeSummary";
import { taskRef } from "../../lib/taskRef";
import { formatThreadStamp } from "../../lib/threadStamp";
import { greetingName, greetingPeriod } from "../../lib/welcomeRecap";
import type { AgentName } from "relay-core";
import type { CurrentUser, DaemonNodeMonitorRecord, ProjectListItem, RelaySession, RelayTaskListItem, TasksResponse } from "../../types";
import { HomeQueue } from "./HomeQueue";
import { CardHeader, FinishedPanel, HomeLink, ProjectsPanel, RunningPanel } from "./HomePanels";
import { HomeSetupFocus, HomeSetupPanel } from "./HomeSetupPanel";
import { HomeStatsPanel } from "./HomeStatsPanel";
import { HomeTokenChart } from "./HomeTokenChart";
import type { HomeSetupProgress } from "../../lib/onboarding";
import { homeSetup } from "../../lib/homeSetup";
import { useHomeActions } from "./useHomeActions";

export interface HomePageProps {
  user: CurrentUser;
  /** The owner key tasks and threads carry — the shell's selected user. */
  userId: string;
  setUser: (user: CurrentUser) => void;
  items: readonly HomeItem[];
  needsYou: number;
  dataStatus: ProjectCollectionStatus;
  /** Unfinished setup, or null once there is nothing left to set up. */
  setupProgress: HomeSetupProgress | null;
  onOpenOnboarding: () => void;
  onRefresh: () => Promise<void>;
  onOpenRoutineRecord: (id: string, runId?: string) => void;
  tasks: readonly RelayTaskListItem[];
  taskProjects?: TasksResponse["homeProjects"];
  sessions: readonly RelaySession[];
  projects: readonly ProjectListItem[];
  nodes: readonly DaemonNodeMonitorRecord[];
  onOpenThread: (sessionId: string, replace?: boolean, parentTaskId?: string) => void;
  onOpenTaskRecord: (taskId: string | null) => void;
}

const threadPath = (sessionId: string) => hrefForRoute("main", sessionId);
const taskPath = (taskId: string) => pathForAppState({ route: "backlog", mobileView: "chat", sessionId: null, taskId });
const projectPath = (projectId: string) => pathForAppState({ route: "projects", mobileView: "threads", sessionId: null, projectId });
const tasksPath = (search = "") => `${hrefForRoute("backlog")}${search}`;
const READY_PREVIEW = 3;
const MINUTE_MS = 60_000;

/** Home: editorial 12-column personal workspace combining weekly activity stats,
 *  the ranked attention queue, daily token trend, projects, and upcoming work. */
export function HomePage({ user, userId, setUser, items, needsYou, tasks, taskProjects, sessions, projects, nodes, onOpenThread, onOpenTaskRecord, dataStatus, setupProgress, onOpenOnboarding, onRefresh, onOpenRoutineRecord }: HomePageProps) {
  const { t, i18n } = useTranslation();
  const now = useMinuteClock();
  const actions = useHomeActions(setUser);
  const [statsPeriod, setStatsPeriod] = useState<HomeStatsPeriod>("week");
  const statsQuery = useHomeStats(statsPeriod, dataStatus === "ready");
  const { agents } = useUserAgents(user.userId);
  const { teams } = useTeams(user.userId);
  const today = isoToday(new Date(now));
  const [readyExpanded, setReadyExpanded] = useState(false);
  const upcoming = useMemo(() => homeUpcoming(tasks, userId, today), [tasks, userId, today]);
  const blockers = useMemo(() => homeBlockers(tasks, userId), [tasks, userId]);
  const readyCandidates = useMemo(() => readyHomeTasks(tasks, projects, userId), [tasks, projects, userId]);
  const workflowChoices = useProjectWorkflowChoices(undefined, readyCandidates.some(task =>
    !task.assignedTeamId && task.assignedWorkflowId && !predefinedStyle(task.assignedWorkflowId)));
  const ready = useMemo(() => readyCandidates.filter(task => {
    const project = projects.find(p => p.id === task.projectId)!;
    if (!nodes.some(n => computerId(n) === project.computerId && n.online && !n.stale && !n.retiredAt)) return false;
    if (task.assignedTeamId) {
      const team = teams.find(t => t.id === task.assignedTeamId);
      return Boolean(team && isTeamRoutable(team) && teamOnComputer(team, agents, project.computerId));
    }
    if (task.assignedWorkflowId) {
      return homeProjectWorkflowReady(task.assignedWorkflowId, project, agents, workflowChoices.data?.workflows ?? []);
    }
    const agent = agents.find(a => a.id === task.assignedAgentId);
    return Boolean(agent && isUserAgentRoutable(agent) && agentOnComputer(agent, project.computerId));
  }), [readyCandidates, projects, nodes, agents, teams, workflowChoices.data]);
  // Unfinished setup takes the Start here slot; ready work then stays listed.
  const readyFocus = !homeFocusItem(items) && !setupProgress ? ready[0] : undefined;
  const readyRest = ready.filter(t => t.id !== readyFocus?.id);

  const agentNames = useMemo(() => new Map(agents.map((agent) => [agent.id, agent.displayName])), [agents]);
  const projectNames = useMemo(() => new Map(projects.map((project) => [project.id, project.name])), [projects]);
  const nodesById = useMemo(() => new Map(nodes.map((node) => [node.id, node])), [nodes]);
  const projectRows = useMemo(() => homeProjects(projects, tasks, items, undefined, taskProjects), [items, projects, tasks, taskProjects]);
  const running = useMemo(() => runningNow(sessions, nodes, userId), [nodes, sessions, userId]);
  const setup = useMemo(() => homeSetup(nodes, agents, userId), [agents, nodes, userId]);
  const finished = useMemo(() => recentlyFinished(tasks, userId), [tasks, userId]);

  const locale = i18n.resolvedLanguage ?? "en";
  const todayFormatted = useMemo(
    () => new Date(now).toLocaleDateString(locale, { weekday: "short", month: "short", day: "numeric" }),
    [locale, today],
  );
  const sinceLabel = useCallback((iso: string) => formatThreadStamp(iso, locale, now), [locale, now]);
  const runningFor = useCallback((iso: string) => t("home.running_for", {
    duration: formatRunDuration(Math.max(1, Math.floor((now - Date.parse(iso)) / MINUTE_MS)) * MINUTE_MS),
  }), [now, t]);
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

  const name = greetingName(user);
  const first = needsYou
    ? { tone: "warn", text: t("home.brief.needs", { count: needsYou }) }
    : setupProgress
      ? { tone: "neutral", text: t("home.brief.setup", { done: setupProgress.done, total: setupProgress.total }) }
      : { tone: "ok", text: t("home.brief.clear") };
  const summary = [
    first,
    { tone: running.length ? "live" : "neutral", text: t("home.brief.running", { count: running.length }) },
  ];
  const readyVisible = readyExpanded ? readyRest : readyRest.slice(0, READY_PREVIEW);

  const nextLabel = (row: HomeProjectRow): string => {
    if (row.next) return t("home.project_next", { what: nextSummary(row.next, t) });
    if (row.total > 0 && row.progress.done === row.total) return t("home.project_all_done");
    if (row.progress.running) return t("home.project_running", { count: row.progress.running });
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
        <div className="home-canvas">
          <PageHeader
            title={<span id="home-title">{t(`transcript.welcome_greeting_${greetingPeriod(new Date(now).getHours())}`, { name })}</span>}
            titleVariant="display"
            layout="stacked"
            subtitle={dataStatus !== "ready" ? t(`home.plan.${dataStatus}`) : (
              <span className="home-brief">
                <span className="home-brief-date">{todayFormatted}</span>
                {summary.map(({ tone, text }) => (
                  <span key={text} className="home-brief-status" data-tone={tone}>
                    <i aria-hidden="true" />{text}
                  </span>
                ))}
              </span>
            )}
          />

          {dataStatus === "error" ? (
            <div className="home-card home-data-state" role="alert">
              <p>{t("home.plan.error_detail")}</p>
              <Button variant="outline" onClick={() => void onRefresh()}>{t("home.plan.retry")}</Button>
            </div>
          ) : dataStatus === "loading" ? (
            <div className="home-data-state home-data-loading">
              <ListSkeleton label={t("home.plan.loading_detail")} rows={4} />
            </div>
          ) : (
            <div className="home-board">
              {/* Row 1: 4 × span 3 personal stats */}
              <HomeStatsPanel
                period={statsPeriod}
                onPeriodChange={setStatsPeriod}
                stats={statsQuery.data}
                isLoading={statsQuery.isLoading}
                isFetching={statsQuery.isFetching}
                isError={statsQuery.isError}
                onRetry={() => void statsQuery.refetch()}
                tasksHref={tasksPath()}
                threadsHref={hrefForRoute("main")}
                onOpenTasks={() => void navigateToAppPath(tasksPath())}
                onOpenThreads={() => void navigateToAppPath(hrefForRoute("main"))}
              />

              {/* Row 2: span 6 attention queue + span 6 daily token trend (col 6 seam, both above the fold) */}
              <div className="home-slot-half">
                <HomeQueue
                  items={items}
                  contextLinks={
                    <nav className="home-mobile-context" aria-label={t("home.plan.jump_to")}>
                      {running.length ? <a href="#home-running-title">{t("home.plan.running_jump", { count: running.length })}</a> : null}
                      {readyRest.length ? <a href="#home-ready-title">{t("home.plan.ready_jump", { count: readyRest.length })}</a> : null}
                      <a href="#home-upcoming-title">{t("home.plan.upcoming_jump", { count: upcoming.length })}</a>
                      {blockers.length ? <a href="#home-blockers-title">{t("home.plan.blockers_jump", { count: blockers.length })}</a> : null}
                    </nav>
                  }
                  readyFocus={setupProgress
                    ? <HomeSetupFocus progress={setupProgress} onOpen={onOpenOnboarding} />
                    : readyFocus ? <ReadyTask key={readyFocus.id} task={readyFocus} onStart={actions.startTask} href={taskPath(readyFocus.id)} onOpen={() => onOpenTaskRecord(readyFocus.id)} focus /> : undefined}
                  actions={actions}
                  agentName={agentName}
                  projectName={projectName}
                  sinceLabel={sinceLabel}
                  hrefFor={hrefFor}
                  onOpen={openItem}
                  needsMeHref={tasksPath("?queue=needs_me")}
                  onOpenNeedsMe={() => void navigateToAppPath(tasksPath("?queue=needs_me"))}
                />
              </div>

              <div className="home-slot-half">
                <HomeTokenChart
                  tokens={statsQuery.data?.tokens}
                  isLoading={statsQuery.isLoading}
                  isError={statsQuery.isError}
                />
              </div>

              {/* Row 3: span 6 projects + span 6 live runs & recently completed (col 6 seam) */}
              <div className="home-slot-half">
                <ProjectsPanel
                  rows={projectRows}
                  nextLabel={nextLabel}
                  hrefFor={(row) => projectPath(row.project.id)}
                  onOpen={(row) => void navigateToAppPath(projectPath(row.project.id))}
                  allHref={hrefForRoute("projects")}
                  onOpenAll={() => void navigateToAppPath(hrefForRoute("projects"))}
                  onNewProject={() => void navigateToAppPath(hrefForRoute("projects"))}
                />
              </div>

              <div className="home-slot-stack">
                <HomeSetupPanel
                  setup={setup}
                  computersHref={hrefForRoute("computers")}
                  agentsHref={hrefForRoute("agents")}
                  onOpenComputers={() => void navigateToAppPath(hrefForRoute("computers"))}
                  onOpenAgents={() => void navigateToAppPath(hrefForRoute("agents"))}
                />
                <RunningPanel
                  rows={running}
                  title={runTitle}
                  agentName={runAgent}
                  computerName={runComputer}
                  elapsed={runningFor}
                  hrefFor={(row) => threadPath(row.session.id)}
                  onOpen={(row) => onOpenThread(row.session.id)}
                  allHref={hrefForRoute("main")}
                  onOpenAll={() => void navigateToAppPath(hrefForRoute("main"))}
                />
                <FinishedPanel
                  tasks={finished}
                  sinceLabel={sinceLabel}
                  hrefFor={(task) => taskPath(task.id)}
                  onOpen={(task) => onOpenTaskRecord(task.id)}
                />
              </div>

              {/* Row 4: span 6 upcoming + span 6 ready to start (col 6 seam) */}
              <div className="home-slot-half home-slot-auto">
                <UpcomingPanel
                  rows={upcoming}
                  today={today}
                  hrefFor={row => row.task.isRoutine ? pathForAppState({ route: "routine", mobileView: "chat", sessionId: null, taskId: row.task.id }) : taskPath(row.task.id)}
                  onOpen={row => row.task.isRoutine ? onOpenRoutineRecord(row.task.id) : onOpenTaskRecord(row.task.id)}
                />
              </div>

              <div className="home-slot-half home-slot-auto">
                <section className="home-card" aria-labelledby="home-ready-title">
                  <CardHeader
                    id="home-ready-title"
                    title={t("home.plan.ready_work")}
                    count={readyRest.length}
                    more={<HomeLink className="home-link" href={tasksPath()} onOpen={() => void navigateToAppPath(tasksPath())}>{t("home.all_tasks")}</HomeLink>}
                  />
                  <div className="home-card-body">
                    {readyVisible.length > 0 ? (
                      <>
                        {readyVisible.map((task) => (
                          <ReadyTask key={task.id} task={task} onStart={actions.startTask} href={taskPath(task.id)} onOpen={() => onOpenTaskRecord(task.id)} />
                        ))}
                        {readyRest.length > READY_PREVIEW
                          ? <ShowAllToggle count={readyRest.length} expanded={readyExpanded} onToggle={() => setReadyExpanded(!readyExpanded)} />
                          : null}
                      </>
                    ) : (
                      <p className="home-card-empty">
                        {t(readyFocus ? "home.plan.no_more_ready" : "home.plan.none_ready")}
                      </p>
                    )}
                  </div>
                </section>
              </div>

              {/* Row 5: span 12 shared blockers (only when present) */}
              {blockers.length > 0 ? (
                <div className="home-slot-full">
                  <BlockersPanel rows={blockers} onOpenTask={onOpenTaskRecord} taskHref={taskPath} />
                </div>
              ) : null}
            </div>
          )}
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
