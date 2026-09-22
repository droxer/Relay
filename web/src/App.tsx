"use client";

import { reconcileExecution, retryExecutionRecovery } from "./api";

import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { logout } from "./api";
import type { AgentName, AgentTeam, EmployeeAgent, RelayArtifact, RelaySession } from "./types";
import { ScreenErrorBoundary } from "./components/ScreenErrorBoundary";
import { DeviceApproval } from "./components/computer/DeviceApproval";
import { LoginScreen } from "./components/LoginScreen";
import { useRelayData } from "./hooks/useRelayData";
import { useRelayMutations } from "./hooks/useRelayMutations";
import { useMutationError } from "./hooks/useMutationError";
import { useAppRouter } from "./hooks/useAppRouter";
import { useSessionEvents } from "./hooks/useSessionEvents";
import { useSessionDetail } from "./hooks/useSessionDetail";
import { useLocalDaemonNodes } from "./hooks/useLocalDaemonNodes";
import { mergeThreadRuntimeNodes, mergeVisibleDaemonNodes } from "./lib/daemonNodes";
import { isEmployeeAgentRoutable, preferredRoutableAgent } from "./lib/agentDisplayNames";
import { mentionCandidates } from "./lib/mentions";
import { applyTheme, readTokens, selectedEmployeeKey } from "./lib/appStorage";
import { canUseLocalControlPanel } from "./lib/controlPanel";
import { useThreadDispatch } from "./hooks/useThreadDispatch";
import { useRelayStore } from "./lib/store";
import { useAuthSession } from "./hooks/useAuthSession";
import { useClientMounted } from "./hooks/useClientMounted";
import { useActiveSession } from "./hooks/useActiveSession";
import { useTranscriptPin } from "./hooks/useTranscriptPin";
import { useThreadDirectory } from "./hooks/useThreadDirectory";
import { useThreadTargets } from "./hooks/useThreadTargets";
import { useUserPreferences } from "./hooks/useUserPreferences";
import { usePanelLayout } from "./hooks/usePanelLayout";
import { useThreadSpace } from "./hooks/useThreadSpace";
import { myThreadSessions, pickActiveThreadSession } from "./lib/threads";
import { shouldTailSessionEvents } from "./lib/sessionEventStream";
import { useEmployeeProvisioning } from "./hooks/useEmployeeProvisioning";
import { useEmployeeAgents } from "./hooks/useEmployeeAgents";
import { useTeams } from "./hooks/useTeams";
import { isAwaitingFeedbackDecision } from "./lib/workflow";
import { useDialogs } from "./components/ui/DialogProvider";
import { AppShell, RouteFallback } from "./components/AppShell";
import { ThreadsView } from "./components/ThreadsView";
import type { ComposerHandle } from "./components/composer/Composer";
import type { DerivedMessage } from "./components/MessageBlock";
import { ProjectMessagesAccumulator } from "./lib/projectMessages";
import type { AppRoute } from "./lib/viewTypes";
import { visibleThreadArtifacts } from "./lib/threadArtifacts";
import {
  findActiveRunOwnerForSession,
  isThreadRunInFlight,
} from "./lib/threadRunning";
import {
  addressableThreadAgents,
  resolveNewThreadComputer,
  teamRosterForThread,
} from "./lib/threadRuntime";
import { navigateToAppPath, validatedReturnTo } from "./lib/appRoute";
import { taskCreateIntent } from "./lib/taskCreateIntent";
import { showThreadChrome } from "./lib/projectPage";

const AdminPage = lazy(() => import("./components/AdminPage").then((m) => ({ default: m.AdminPage })));
const TasksWorkspace = lazy(() => import("./components/TasksWorkspace").then((m) => ({ default: m.TasksWorkspace })));
const ChannelsPage = lazy(() => import("./components/ChannelsPage").then((m) => ({ default: m.ChannelsPage })));
const RoutinesPage = lazy(() => import("./components/RoutinesPage").then((m) => ({ default: m.RoutinesPage })));
const AgentsPage = lazy(() => import("./components/AgentsPage").then((m) => ({ default: m.AgentsPage })));
const TeamsPage = lazy(() => import("./components/TeamsPage").then((m) => ({ default: m.TeamsPage })));
const SettingsPage = lazy(() => import("./components/SettingsPage").then((m) => ({ default: m.SettingsPage })));

const WORK_ROUTE_SKIP_IDS: Record<Exclude<AppRoute, "main" | "projects">, string> = {
  backlog: "backlog-panel",
  routine: "routine-panel",
  agents: "agents-panel",
  teams: "teams-panel",
  settings: "settings-panel",
  channels: "channels-panel",
  admin: "admin-panel",
};

function useStableEvent<TArgs extends unknown[], TResult>(handler: (...args: TArgs) => TResult): (...args: TArgs) => TResult {
  const handlerRef = useRef(handler);
  useEffect(() => {
    handlerRef.current = handler;
  });
  return useCallback((...args: TArgs) => handlerRef.current(...args), []);
}

// ── App ───────────────────────────────────────────────────────────────────────

export function App() {
  const { t, i18n } = useTranslation();
  const { prompt, confirm } = useDialogs();
  const { reportMutationError } = useMutationError();
  const {
    renameSessionMutation,
    deleteSessionMutation,
    cancelRunMutation,
    recordDecisionMutation,
    runLogicalAgentsMutation,
    submitThreadMessageMutation,
    requestThreadRecoveryMutation,
  } = useRelayMutations();
  const selectedEmployee = useRelayStore((s) => s.selectedEmployee);
  const setSelectedEmployee = useRelayStore((s) => s.setSelectedEmployee);
  const selectedSessionId = useRelayStore((s) => s.selectedSessionId);
  const setSelectedSessionId = useRelayStore((s) => s.setSelectedSessionId);
  const tokens = useRelayStore((s) => s.tokens);
  const setTokens = useRelayStore((s) => s.setTokens);
  const [hydrated, setHydrated] = useState(false);
  const [activeAgent, setActiveAgent] = useState<AgentName>("claude");
  const [activeLogicalAgentId, setActiveLogicalAgentId] = useState<string | null>(null);
  // Team picked in the composer while staging a brand-new thread; cleared the
  // moment an existing thread opens or the pick is sent.
  const [pendingThreadTeamId, setPendingThreadTeamId] = useState<string | null>(null);
  // A project thread talks to the whole roster by default; picking one member
  // in the composer narrows the round to them until the roster is picked again.
  const [projectRoomTarget, setProjectRoomTarget] = useState(true);
  const [threadQuery, setThreadQuery] = useState("");
  const [sidenavResizing, setSidenavResizing] = useState(false);
  const [handoffOpen, setHandoffOpen] = useState(false);
  const [spaceResizing, setSpaceResizing] = useState(false);
  const [threadListResizing, setThreadListResizing] = useState(false);
  const [handoffAgentId, setHandoffAgentId] = useState<string>("");
  const [handoffNote, setHandoffNote] = useState("");
  const [isRunning, setIsRunning] = useState(false);
  const [newThreadNodeId, setNewThreadNodeId] = useState<string | null>(null);
  // True while the composer is staging a brand-new thread: suppresses the
  // fall-back to the most-recent session so the transcript shows the empty state
  // and the next send creates a fresh owner-scoped session.
  const [composingNew, setComposingNew] = useState(false);
  // Optimistic echo of the just-sent turn: shown immediately so the user sees
  // their message without waiting for the provision + run round-trip. It is
  // hidden once the persisted turn arrives (matched by id for a continued
  // session, or by text for the goal of a freshly created one).
  const [pendingUserMessage, setPendingUserMessage] = useState<{ id: string; text: string } | null>(null);
  const { user, authChecked, setUser } = useAuthSession();
  const mounted = useClientMounted();
  const panels = usePanelLayout(mounted);
  const preferences = useUserPreferences({
    mounted,
    i18n,
    setUser,
    reportMutationError,
    saveErrorMessage: t("errors.save_preferences"),
  });
  const { agents: logicalAgents } = useEmployeeAgents(user?.employeeId);
  const { teams } = useTeams(user?.employeeId);
  const localNodeAdoptionStartedRef = useRef(false);
  const [preferencesUserId, setPreferencesUserId] = useState<string | null>(null);
  const composerRef = useRef<ComposerHandle>(null);
  const messageProjectorRef = useRef(new ProjectMessagesAccumulator());
  const messageOperationIdsRef = useRef(new Map<string, string>());
  const recoveryOperationIdsRef = useRef(new Map<string, string>());

  const selectedEmployeeToken = tokens[selectedEmployee];
  const {
    sandboxes,
    nodes,
    sessions,
    tasks,
    projects,
    projectsStatus,
    tasksStatus,
    projectsError,
    isRefreshing,
    refresh,
    setSandboxes,
  } = useRelayData(selectedEmployeeToken, Boolean(user));
  const { localNodes, refreshLocalDaemonNodes } = useLocalDaemonNodes(
    hydrated && user?.role === "admin" && canUseLocalControlPanel(),
  );
  const visibleNodes = useMemo(() => mergeVisibleDaemonNodes(nodes, localNodes), [nodes, localNodes]);
  const runtimeNodes = useMemo(
    () => mergeThreadRuntimeNodes(nodes, localNodes),
    [localNodes, nodes],
  );
  const selectedSandbox = useMemo(() => sandboxes.find((s) => s.employeeId === selectedEmployee), [sandboxes, selectedEmployee]);
  // The logged-in user is themselves an employee; their threads are the
  // sessions they own. The backend already owner-scopes /api/v1/threads, so this is
  // just the non-archived sessions sorted most-recent first.
  const myThreads = useMemo(
    () => myThreadSessions(sessions, selectedEmployee),
    [sessions, selectedEmployee],
  );
  const { activeSessionId, setActiveSessionId } = useActiveSession(selectedEmployee, myThreads);
  const activeSession = useMemo(
    () => pickActiveThreadSession({
      threads: myThreads,
      selectedSessionId,
      activeSessionId,
      composingNew,
    }),
    [activeSessionId, composingNew, myThreads, selectedSessionId],
  );
  const space = useThreadSpace(activeSession?.id);
  const {
    assignableComputers,
    threadComputers,
    initializingThread,
    selectedThreadNodeId,
    activeRuntimeNode,
    selectedThreadComputer,
    selectableLogicalAgents,
    composerTeams,
    threadParticipants,
  } = useThreadTargets({
    activeSession,
    composingNew,
    logicalAgents,
    newThreadNodeId,
    runtimeNodes,
    selectedEmployee,
    teams,
  });

  const visibleArtifacts = useMemo(() => visibleThreadArtifacts(activeSession), [activeSession]);

  useEffect(() => {
    if (!initializingThread) return;
    setNewThreadNodeId((previous) => {
      const next = resolveNewThreadComputer(previous, threadComputers, assignableComputers);
      return next === previous ? previous : next;
    });
  }, [assignableComputers, initializingThread, threadComputers]);

  // A team picked while staging only holds while the picked computer hosts
  // the whole roster; switching computers drops the pick back to an agent.
  useEffect(() => {
    if (!pendingThreadTeamId) return;
    if (!composerTeams.some((team) => team.id === pendingThreadTeamId)) {
      setPendingThreadTeamId(null);
    }
  }, [composerTeams, pendingThreadTeamId]);

  const applySessionFromHash = useCallback((sessionId: string) => {
    setComposingNew(false);
    setPendingThreadTeamId(null);
    setSelectedSessionId(sessionId);
    setActiveSessionId(sessionId);
  }, [setActiveSessionId, setSelectedSessionId]);

  const setComposingNewFromPath = useCallback((next: boolean) => {
    setComposingNew(next);
    if (!next) return;
    setSelectedSessionId(undefined);
    setActiveSessionId(null);
  }, [setActiveSessionId, setSelectedSessionId]);

  const clearPendingMessage = useCallback(() => {
    setPendingUserMessage(null);
  }, []);

  const {
    route,
    mobileView,
    routedSessionId,
    projectId: routedProjectId,
    agentId,
    recordTaskId,
    recordRunId,
    teamWorkspaceId,
    settingsSection,
    adminSection,
    notFound,
    isLoginPath,
    navigateToRoute,
    navigateToMobileView,
    hrefForSideNavRoute,
    syncThreadUrl,
    navigateToAgent,
    navigateToTaskRecord,
    navigateToRoutineRecord,
    navigateToSettings,
    navigateToAdminSection,
    navigateToTeamWorkspace,
    navigateToProject,
    navigateToLogin,
  } = useAppRouter({
    composingNew,
    activeSessionId,
    selectedSessionId,
    activeSession,
    onApplySessionFromPath: applySessionFromHash,
    onSetComposingNewFromPath: setComposingNewFromPath,
    onClearPendingMessage: clearPendingMessage,
  });
  const activeProject = useMemo(() => {
    const id = routedProjectId ?? activeSession?.projectId;
    return id ? projects.find((project) => project.id === id) ?? null : null;
  }, [activeSession?.projectId, projects, routedProjectId]);
  const projectDispatchDisabled = Boolean(
    activeProject && (activeProject.archivedAt || !activeProject.enabled),
  );
  // Narrowing a round to one member is a per-thread choice, not a standing
  // preference: opening another thread (or another project) starts at the room.
  useEffect(() => {
    setProjectRoomTarget(true);
  }, [activeProject?.id, activeSession?.id]);
  // A thread that belongs to a team answers only its members, exactly as a
  // project thread answers only its own. Both rosters narrow the same lists —
  // the `@` popup and the handoff picker — so neither surface can offer a
  // target the round would refuse.
  const activeTeamRoster = useMemo(
    () => teamRosterForThread(activeSession?.teamId, teams),
    [activeSession?.teamId, teams],
  );
  const effectiveSelectableLogicalAgents = useMemo(() => {
    if (activeProject) {
      return addressableThreadAgents(logicalAgents, {
        leadAgentId: activeProject.leadAgentId,
        memberAgentIds: activeProject.members
          .filter((member) => member.enabled)
          .map((member) => member.agentId),
      });
    }
    if (activeTeamRoster) {
      return addressableThreadAgents(selectableLogicalAgents, activeTeamRoster);
    }
    return selectableLogicalAgents;
  }, [activeProject, activeTeamRoster, logicalAgents, selectableLogicalAgents]);
  const threadMentionCandidates = useMemo(
    () => mentionCandidates(effectiveSelectableLogicalAgents),
    [effectiveSelectableLogicalAgents],
  );
  const requiresRuntimeSelection = initializingThread && !activeProject;
  const showProjectOverview = route === "projects"
    && Boolean(routedProjectId)
    && !routedSessionId
    && !composingNew;
  const showProjectDirectoryEmpty = route === "projects"
    && !routedProjectId
    && !routedSessionId
    && !composingNew;
  const activeThreadTaskId = tasks.find(task => task.linkedSessionIds.includes(activeSession?.id ?? ""))?.id;
  const isTaskThread = route === "backlog" && Boolean(recordTaskId && routedSessionId);
  const isTasksWorkspace = route === "backlog" && !isTaskThread;
  const detailAgent = useMemo(
    () => logicalAgents.find((agent) => agent.id === agentId) ?? null,
    [agentId, logicalAgents],
  );

  useEffect(() => {
    if (!mounted || !authChecked || typeof window === "undefined") return;
    const current = `${window.location.pathname}${window.location.search}`;
    if (!user && window.location.pathname !== "/login") {
      const returnTo = validatedReturnTo(current, window.location.origin);
      const loginUrl = `/login?returnTo=${encodeURIComponent(returnTo)}`;
      window.history.replaceState(window.history.state, "", loginUrl);
      window.dispatchEvent(new PopStateEvent("popstate"));
      return;
    }
    if (user && isLoginPath) {
      const returnTo = validatedReturnTo(new URL(window.location.href).searchParams.get("returnTo"), window.location.origin);
      window.history.replaceState(window.history.state, "", returnTo);
      window.dispatchEvent(new PopStateEvent("popstate"));
    }
  }, [authChecked, isLoginPath, mounted, user]);

  // Live SSE tail of the open thread; merges new events into the
  // sessions cache so the active thread updates at push latency.
  useSessionDetail(activeSession?.id, Boolean(user));
  useSessionEvents(activeSession?.id, Boolean(user) && shouldTailSessionEvents(activeSession?.status));

  const selectedToken = selectedSandbox ? (tokens[selectedSandbox.id] ?? tokens[selectedEmployee]) : tokens[selectedEmployee];
  const activeRunOwner = useMemo(
    () => findActiveRunOwnerForSession(visibleNodes, activeSession?.id),
    [visibleNodes, activeSession?.id],
  );
  const activeRun = activeRunOwner?.run;
  const threadRunning = isThreadRunInFlight({
    activeRun,
    session: activeSession,
    pendingSend: pendingUserMessage !== null,
    dispatchingRun: isRunning,
  });
  const messages = useMemo<DerivedMessage[]>(
    () => messageProjectorRef.current.update(activeSession, t),
    [activeSession, t],
  );
  const displayMessages = useMemo<DerivedMessage[]>(() => {
    if (!pendingUserMessage) return messages;
    const present = messages.some(
      (m) => m.kind === "user" && (m.id === pendingUserMessage.id || m.text === pendingUserMessage.text),
    );
    if (present) return messages;
    return [
      ...messages,
      { kind: "user", id: pendingUserMessage.id, timestamp: new Date().toISOString(), text: pendingUserMessage.text },
    ];
  }, [messages, pendingUserMessage]);

  // Declared after displayMessages: the pin re-runs on block count and
  // session id, both of which are derived above.
  const transcript = useTranscriptPin(displayMessages.length, activeSession?.id);

  useEffect(() => {
    if (!pendingUserMessage) return;
    const present = messages.some(
      (m) => m.kind === "user" && (m.id === pendingUserMessage.id || m.text === pendingUserMessage.text),
    );
    if (present) setPendingUserMessage(null);
  }, [messages, pendingUserMessage]);

  const activeThreadLabel = showProjectOverview && activeProject
    ? activeProject.name
    : activeSession
      ? (activeSession.title?.trim() || activeSession.taskGoal)
      : t("thread.new_thread");

  const skipLinkHref = useMemo(() => {
    if (isTaskThread) return "#chat-panel";
    if (route === "projects" && showProjectOverview) return "#project-detail-panel";
    if (route === "main" || route === "projects") return mobileView === "threads" ? "#thread-panel" : "#chat-panel";
    if (route === "agents" && agentId) return "#agent-detail-panel";
    return `#${WORK_ROUTE_SKIP_IDS[route]}`;
  }, [agentId, route, mobileView, showProjectOverview, showProjectDirectoryEmpty, isTaskThread]);

  const awaitingDecision = useMemo(() => isAwaitingFeedbackDecision(activeSession), [activeSession]);

  const threadChromeVisible = showThreadChrome(isTasksWorkspace || showProjectOverview || showProjectDirectoryEmpty);
  const spaceVisible = threadChromeVisible
    && (route === "main" || route === "projects" || isTaskThread)
    && space.open
    && Boolean(activeSession);

  const { directoryProjects, directoryThreads } = useThreadDirectory({
    route,
    myThreads,
    projects,
    routedProjectId,
    threadQuery,
    tasks,
    visibleNodes,
    runtimeNodes,
    logicalAgents,
  });

  const refreshWithToken = useCallback(async (tokenOverride?: string) => {
    await refresh(undefined, tokenOverride);
  }, [refresh]);

  const { adoptLocalDaemonNodes } = useEmployeeProvisioning({
    nodes,
    setSandboxes,
    refreshLocalDaemonNodes,
    refreshWithToken,
  });

  useEffect(() => {
    preferences.invalidate(user?.id ?? null);
  }, [user?.id]);

  useEffect(() => {
    if (!mounted) return;
    if (!user) {
      setPreferencesUserId(null);
      return;
    }
    if (preferencesUserId === user.id) return;

    const nextTheme = user.theme ?? "system";
    const nextLanguage = user.language ?? "en";
    preferences.adopt({ theme: nextTheme, language: nextLanguage });
    applyTheme(nextTheme);
    document.documentElement.lang = nextLanguage;
    const languageChange = i18n.language === nextLanguage
      ? Promise.resolve()
      : i18n.changeLanguage(nextLanguage);
    void languageChange
      .catch(() => undefined)
      .finally(() => setPreferencesUserId(user.id));
  }, [i18n, mounted, preferencesUserId, user]);

  useEffect(() => {
    if (!authChecked) return;
    setTokens(readTokens());
    // The logged-in user is their own employee; their threads are the
    // sessions they own. Pin the selection to self so the chat view always
    // shows the current employee's own work (never another employee's).
    const myEmployeeId = user?.employeeId ?? user?.username ?? "";
    if (myEmployeeId) setSelectedEmployee(myEmployeeId);
    setHydrated(true);
  }, [authChecked, user]);
  // Adoption reads /api/v1/admin/daemon-nodes, which is admin-only: running it for every
  // signed-in user meant a 403 on each load whose failure was swallowed. Gate
  // it exactly like the query it depends on (useLocalDaemonNodes above).
  useEffect(() => {
    if (!hydrated || user?.role !== "admin" || !canUseLocalControlPanel()) return;
    if (localNodeAdoptionStartedRef.current) return;
    localNodeAdoptionStartedRef.current = true;
    void adoptLocalDaemonNodes();
  }, [adoptLocalDaemonNodes, hydrated, user]);
  // Admin local-node polling now lives in useLocalDaemonNodes (refetchInterval).
  useEffect(() => {
    if (!hydrated) return;
    if (selectedEmployee) {
      localStorage.setItem(selectedEmployeeKey, selectedEmployee);
    } else {
      localStorage.removeItem(selectedEmployeeKey);
    }
  }, [selectedEmployee, hydrated]);
  useEffect(() => {
    if (effectiveSelectableLogicalAgents.length === 0) {
      setActiveLogicalAgentId(null);
      return;
    }
    const selected = preferredRoutableAgent(effectiveSelectableLogicalAgents, activeLogicalAgentId);
    setActiveLogicalAgentId(selected?.id ?? null);
    if (selected) setActiveAgent(selected.executorKind);
    if (!effectiveSelectableLogicalAgents.some((agent) => agent.id === handoffAgentId && isEmployeeAgentRoutable(agent))) {
      setHandoffAgentId(effectiveSelectableLogicalAgents.find(isEmployeeAgentRoutable)?.id ?? "");
    }
  }, [activeLogicalAgentId, effectiveSelectableLogicalAgents, handoffAgentId]);
  useEffect(() => {
    if ((route === "admin" || route === "channels") && user && user.role !== "admin") {
      navigateToRoute("main");
    }
  }, [navigateToRoute, route, user]);
  function openThread(sessionId: string, replace = false, parentTaskId?: string) {
    const session = myThreads.find((candidate) => candidate.id === sessionId);
    const ownerTaskId = tasks.find((task) => task.linkedSessionIds.includes(sessionId))?.id;
    const taskId = parentTaskId ?? (route === "main" ? null : ownerTaskId ?? (route === "backlog" ? recordTaskId : null));
    if (session?.projectId && !ownerTaskId && !taskId) {
      navigateToProject(session.projectId);
      return;
    }
    setComposingNew(false);
    setPendingUserMessage(null);
    setPendingThreadTeamId(null);
    setSelectedSessionId(sessionId);
    setActiveSessionId(sessionId);
    if (taskId) space.setThreadListHidden(false);
    syncThreadUrl(sessionId, replace, session?.projectId ?? routedProjectId,
      taskId);
  }

  // Old project thread links resolve to their task; standalone project rooms
  // no longer have a conversation surface.
  useEffect(() => {
    const projectId = routedProjectId ?? activeSession?.projectId;
    if ((route !== "projects" && route !== "main") || !projectId) return;
    if (route === "projects" && composingNew) {
      void navigateToAppPath(`/backlog?project=${encodeURIComponent(projectId)}`, { replace: true });
    } else if (tasksStatus === "ready" && !composingNew && activeSession
      && (routedSessionId === activeSession.id || (route === "main" && !routedSessionId))) {
      const sessionId = activeSession.id;
      const taskId = tasks.find((task) => task.linkedSessionIds.includes(sessionId))?.id;
      if (route === "main" && taskId) return;
      const path = taskId
        ? `/backlog/${encodeURIComponent(taskId)}/threads/${encodeURIComponent(sessionId)}?project=${encodeURIComponent(projectId)}`
        : `/projects/${encodeURIComponent(projectId)}`;
      void navigateToAppPath(path, { replace: true });
    }
  }, [route, routedProjectId, routedSessionId, activeSession, composingNew, tasks, tasksStatus]);

  function startNewThread(projectId: string | null = null) {
    if (projectId) {
      taskCreateIntent()?.queue();
      void navigateToAppPath(`/backlog?project=${encodeURIComponent(projectId)}`);
      return;
    }
    setComposingNew(true);
    setPendingUserMessage(null);
    setSelectedSessionId(undefined);
    setActiveSessionId(null);
    // Same rule as the staging effect: a pick survives a heartbeat flap, and
    // only a machine that is no longer this employee's drops it.
    setNewThreadNodeId((current) => resolveNewThreadComputer(current, threadComputers, assignableComputers));
    composerRef.current?.clear();
    transcript.pinToBottom();
    syncThreadUrl(null, false, projectId);
  }

  function selectProject(projectId: string | null) {
    setComposingNew(false);
    setPendingUserMessage(null);
    setSelectedSessionId(undefined);
    setActiveSessionId(null);
    navigateToProject(projectId);
  }

  function openAgentDetail(agent: EmployeeAgent) {
    navigateToAgent(agent.id);
  }

  async function renameThread(session: RelaySession) {
    const current = session.title?.trim() || session.taskGoal;
    const result = await prompt({
      title: t("thread.rename_prompt"),
      defaultValue: current,
      confirmLabel: t("thread.rename"),
    });
    const next = result?.trim();
    if (!next || next === current) return;
    try {
      await renameSessionMutation.mutateAsync({ sessionId: session.id, title: next, token: selectedToken });
    } catch {
      // mutation onError surfaces a toast.
    }
  }

  async function deleteThread(sessionId: string) {
    const session = myThreads.find((s) => s.id === sessionId);
    const label = session ? (session.title?.trim() || session.taskGoal) : sessionId;
    const ok = await confirm({
      title: t("thread.delete_confirm", { name: label }),
      message: t("thread.delete_message"),
      confirmLabel: t("thread.stop_and_delete"),
      tone: "danger",
    });
    if (!ok) return;
    try {
      const pending = await deleteSessionMutation.mutateAsync({ sessionId, token: selectedToken });
      if (!pending && activeSession?.id === sessionId) {
        setSelectedSessionId(undefined);
        setActiveSessionId(null);
        navigateToRoute("main");
      }
    } catch {
      // mutation onError surfaces a toast.
    }
  }

  const {
    sendMessage,
    cancelActiveRun,
    sendDecision,
    retryAgentMessage,
    sendHandoff,
  } = useThreadDispatch({
    activeSession, activeProject, activeRun, activeRunOwner, activeRuntimeNode,
    threadRunning, requiresRuntimeSelection, projectDispatchDisabled, projectRoomTarget,
    activeAgent, activeLogicalAgentId, effectiveSelectableLogicalAgents,
    threadMentionCandidates, composerTeams, pendingThreadTeamId, handoffAgentId, handoffNote,
    selectedEmployee, selectedSandbox, selectedThreadNodeId, selectedToken, tokens,
    composerRef, transcript, composingNew,
    messageOperationIdsRef, recoveryOperationIdsRef,
    submitThreadMessageMutation, runLogicalAgentsMutation, requestThreadRecoveryMutation,
    recordDecisionMutation, cancelRunMutation,
    setActiveAgent, setActiveLogicalAgentId, setActiveSessionId, setSelectedSessionId,
    setComposingNew, setPendingThreadTeamId, setPendingUserMessage, setIsRunning,
    setHandoffNote, setHandoffOpen, syncThreadUrl, navigateToRoute,
    reportMutationError, t,
  });

  const handleComposerSend = useStableEvent(() => { void sendMessage(); });
  const handleCancelRun = useStableEvent(() => { void cancelActiveRun(); });
  const handleRetryAgent = useStableEvent((agent: AgentName, agentId?: string) => { void retryAgentMessage(agent, agentId); });
  const handleOpenThreadSpace = useStableEvent((artifact?: RelayArtifact) => space.openSpace(artifact?.id ?? null));
  const handleProjectRoomPicked = useStableEvent(() => {
    setProjectRoomTarget(true);
  });
  const handleLogicalAgentPicked = useStableEvent((agent: EmployeeAgent) => {
    setPendingThreadTeamId(null);
    setProjectRoomTarget(false);
    setActiveLogicalAgentId(agent.id);
    setActiveAgent(agent.executorKind);
  });
  const handleTeamPicked = useStableEvent((team: AgentTeam) => {
    setPendingThreadTeamId(team.id);
  });


  async function handleLogout() {
    preferences.invalidate(null);
    try {
      await logout();
    } catch {
      // ignore
    }
    setUser(null);
    navigateToLogin(true);
  }

  if (!mounted || !authChecked || (user && preferencesUserId !== user.id)) {
    return (
      <main className="login-checking" aria-busy="true">
        <p className="login-checking-text">
          {mounted ? t("login.checking") : "Checking authentication…"}
        </p>
      </main>
    );
  }

  if (!user) {
    return <LoginScreen onAuthenticated={(authenticatedUser) => setUser(authenticatedUser)} />;
  }

  const deviceCode = new URL(window.location.href).searchParams.get("connect");
  if (["/computer", "/settings/computers"].includes(window.location.pathname) && deviceCode && /^[A-Za-z0-9_-]{32}$/.test(deviceCode)) {
    return <DeviceApproval code={deviceCode} />;
  }

  return (
    <AppShell
      route={route}
      taskWorkspace={isTasksWorkspace}
      taskThread={isTaskThread}
      settingsSection={settingsSection}
      onNavigateRoute={navigateToRoute}
      hrefForRoute={hrefForSideNavRoute}
      mobileView={mobileView}
      onMobileViewChange={(view) => {
        if (view === "threads" && showProjectOverview) navigateToProject(null);
        else navigateToMobileView(view);
      }}
      sidenavExpanded={panels.sidenavExpanded}
      setSidenavExpanded={panels.setSidenavExpanded}
      sidenavWidth={panels.sidenavWidth}
      sidenavResizing={sidenavResizing}
      onSidenavResize={panels.resizeSidenav}
      onSidenavResizeActive={setSidenavResizing}
      skipLinkHref={skipLinkHref}
      activeThreadLabel={activeThreadLabel}
      threadSpaceOpen={spaceVisible}
      threadSpaceWidth={panels.spaceWidth}
      threadSpaceResizing={spaceResizing}
      threadListHidden={isTaskThread || space.threadListHidden}
      threadListWidth={panels.threadListWidth}
      threadListResizing={threadListResizing}
      mobileChatChrome={threadChromeVisible ? {
        artifactCount: visibleArtifacts.length,
        inProject: Boolean(activeSession?.projectId),
        spaceOpen: spaceVisible,
        spaceDisabled: !activeSession,
        onToggleSpace: space.toggleSpace,
      } : null}
      user={user}
      onLogout={() => void handleLogout()}
      onNewThread={startNewThread}
      onNewTask={() => {
        taskCreateIntent()?.queue();
        if (showProjectOverview && routedProjectId) void navigateToAppPath(`/projects/${encodeURIComponent(routedProjectId)}`);
        else if (route !== "backlog") navigateToRoute("backlog");
      }}
      theme={preferences.theme}
      onThemeChange={preferences.setTheme}
    >
      <ScreenErrorBoundary resetKey={`${route}:${routedSessionId}:${routedProjectId}:${agentId}:${recordTaskId}:${recordRunId}:${teamWorkspaceId}`}>
      <Suspense fallback={<RouteFallback />}>
        {notFound ? (
          <section className="route-loading" role="status">
            <h1>Page not found</h1>
            <p>The requested Relay page does not exist.</p>
          </section>
        ) : route === "admin" ? (
          <AdminPage
            currentUser={user}
            section={adminSection}
            onSelectSection={navigateToAdminSection}
          />
        ) : route === "channels" ? <ChannelsPage /> : isTasksWorkspace ? (
          <TasksWorkspace
            projects={projects}
            projectsStatus={projectsStatus}
            recordTaskId={recordTaskId}
            onOpenRecord={navigateToTaskRecord}
            tasks={tasks}
            sessions={sessions}
            nodes={visibleNodes}
            currentUser={user}
            isRefreshing={isRefreshing}
            onRefresh={() => refresh()}
            onOpenThread={(sessionId, taskId) => openThread(sessionId, false, taskId)}
          />
        ) : route === "routine" ? (
          <RoutinesPage
            projects={projects}
            recordTaskId={recordTaskId}
            recordRunId={recordRunId}
            onOpenRecord={navigateToRoutineRecord}
            tasks={tasks}
            nodes={visibleNodes}
            currentUser={user}
            isRefreshing={isRefreshing}
            onRefresh={() => refresh()}
            onOpenThread={openThread}
          />
        ) : route === "teams" ? (
          <TeamsPage
            currentUser={user}
            onOpenThread={openThread}
            teamId={teamWorkspaceId}
            onSelectTeam={navigateToTeamWorkspace}
          />
        ) : route === "agents" ? (
          <AgentsPage
            currentUser={user}
            detailAgent={detailAgent}
            onOpenAgent={openAgentDetail}
            onBackToAgents={() => navigateToAgent(null)}
            onOpenThread={openThread}
          />
        ) : route === "settings" ? (
          <SettingsPage
            section={settingsSection}
            onSelectSection={navigateToSettings}
            currentUser={user}
            nodes={runtimeNodes}
            onOpenThread={openThread}
            theme={preferences.theme}
            onThemeChange={preferences.setTheme}
            language={preferences.language}
            onLanguageChange={preferences.setLanguage}
          />
        ) : (
          <ThreadsView
            taskId={isTaskThread ? recordTaskId : activeThreadTaskId}
            taskThread={isTaskThread}
            directoryMode={route === "projects" ? "projects" : "threads"}
            tasks={tasks}
            teams={teams}
            currentUser={user}
            filteredThreads={directoryThreads}
            projects={route === "projects" ? directoryProjects : []}
            selectedProjectId={route === "projects" ? routedProjectId : null}
            projectsStatus={projectsStatus}
            projectsError={projectsError}
            onRetryProjects={() => void refresh()}
            showProjectOverview={showProjectOverview}
            showProjectDirectoryEmpty={showProjectDirectoryEmpty}
            threadQuery={threadQuery}
            setThreadQuery={setThreadQuery}
            activeSession={activeSession}
            pendingUserMessage={pendingUserMessage}
            displayMessages={displayMessages}
            awaitingDecision={awaitingDecision}
            transcriptRef={transcript.ref}
            composerRef={composerRef}
            onTranscriptScroll={transcript.onScroll}
            onSelectThread={openThread}
            onSelectProject={selectProject}
            onNewThread={startNewThread}
            onRenameThread={(session) => void renameThread(session)}
            onCloseThread={(id) => void deleteThread(id)}
            activeAgent={activeAgent}
            logicalAgents={logicalAgents}
            selectableLogicalAgents={effectiveSelectableLogicalAgents}
            activeLogicalAgentId={activeLogicalAgentId}
            onLogicalAgentPicked={handleLogicalAgentPicked}
            composerTeams={composerTeams}
            activeTeamId={activeProject ? null : activeSession?.teamId ?? (requiresRuntimeSelection ? pendingThreadTeamId : null)}
            onTeamPicked={handleTeamPicked}
            teamLocked={Boolean(activeSession?.teamId)}
            artifactCount={visibleArtifacts.length}
            visibleArtifacts={visibleArtifacts}
            spaceOpen={spaceVisible}
            spaceArtifactId={space.artifactId}
            spaceWidth={panels.spaceWidth}
            threadListHidden={isTaskThread || space.threadListHidden}
            threadListWidth={panels.threadListWidth}
            onThreadListResize={panels.resizeThreadList}
            onThreadListResizeActive={setThreadListResizing}
            onOpenArtifacts={handleOpenThreadSpace}
            onToggleSpace={space.toggleSpace}
            onCloseSpace={space.closeSpace}
            onSelectSpaceArtifact={space.selectArtifact}
            onSpaceResize={panels.resizeSpace}
            onSpaceResizeActive={setSpaceResizing}
            onToggleThreadList={() => space.setThreadListHidden(!space.threadListHidden)}
            onBackToThreads={() => navigateToMobileView("threads")}
            selectedEmployee={selectedEmployee}
            initializingThread={requiresRuntimeSelection}
            projectName={activeProject?.name}
            projectRoom={activeProject ? { memberCount: effectiveSelectableLogicalAgents.length } : null}
            projectRoomSelected={projectRoomTarget}
            onProjectRoomPicked={handleProjectRoomPicked}
            projectReadOnly={projectDispatchDisabled}
            runtimeNodes={threadComputers}
            runtimeNodeId={selectedThreadNodeId}
            selectedRuntimeNode={selectedThreadComputer}
            activeRuntimeNode={activeRuntimeNode}
            mentionCandidates={threadMentionCandidates}
            threadParticipants={threadParticipants}
            onRuntimeNodeChange={setNewThreadNodeId}
            handoffOpen={handoffOpen}
            setHandoffOpen={setHandoffOpen}
            handoffAgentId={handoffAgentId}
            setHandoffAgentId={setHandoffAgentId}
            handoffNote={handoffNote}
            setHandoffNote={setHandoffNote}
            sendDecision={sendDecision}
            sendHandoff={sendHandoff}
            onSend={handleComposerSend}
            onCancelRun={handleCancelRun}
            onRetryAgent={handleRetryAgent}
            onRetryExecutionRecovery={async () => {
              if (!activeSession) return;
              await retryExecutionRecovery(activeSession.id, selectedToken);
              await refresh();
            }}
            onReportExecutionGone={async () => {
              if (!activeSession) return;
              await reconcileExecution(activeSession.id, selectedToken);
              await refresh();
            }}
            running={threadRunning}
          />
        )}
      </Suspense>
      </ScreenErrorBoundary>
    </AppShell>
  );
}
