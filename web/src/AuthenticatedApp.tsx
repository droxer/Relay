"use client";

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { logout, reconcileExecution, retryExecutionRecovery } from "./api";
import type { AgentName, AgentTeam, CollaborationStyle, CurrentUser, UserAgent, RelayArtifact, ThreadMessageInput } from "./types";
import type { PermissionAnswerInput } from "./lib/permissionRequests";
import { ScreenErrorBoundary } from "./components/ScreenErrorBoundary";
import { WorkRoutePage, showsWorkRoutePage, skipLinkTarget } from "./components/WorkRoutePage";
import { useRelayData } from "./hooks/useRelayData";
import { useRelayMutations } from "./hooks/useRelayMutations";
import { useMutationError } from "./hooks/useMutationError";
import { useAppRouter } from "./hooks/useAppRouter";
import { useSessionEvents } from "./hooks/useSessionEvents";
import { useSessionDetail } from "./hooks/useSessionDetail";
import { useMediaQuery } from "./hooks/useMediaQuery";
import { OVERLAY_TAKEOVER_QUERY } from "./lib/breakpoints";
import { useLocalDaemonNodes } from "./hooks/useLocalDaemonNodes";
import { mergeThreadRuntimeNodes, mergeVisibleDaemonNodes } from "./lib/daemonNodes";
import { isUserAgentRoutable } from "./lib/agentDisplayNames";
import { legacySelectedUserKey, selectedUserKey } from "./lib/appStorage";
import { projectRoomAgentIds } from "./lib/taskAssignment";
import { canUseLocalControlPanel } from "./lib/controlPanel";
import { useThreadDispatch } from "./hooks/useThreadDispatch";
import { useRelayStore } from "./lib/store";
import { homeNeedsYouCount, homeQueue } from "./lib/homeQueue";
import { isoToday } from "./lib/routine";
import { useHandoffStore } from "./lib/handoffStore";
import { useComposerTargetStore } from "./lib/composerTargetStore";
import { useThreadSendStore } from "./lib/threadSendStore";
import { useStableCallback as useStableEvent } from "./hooks/useStableCallback";
import { useClientMounted } from "./hooks/useClientMounted";
import { useActiveSession } from "./hooks/useActiveSession";
import { useThreadDirectory } from "./hooks/useThreadDirectory";
import { useThreadComposerSelection } from "./hooks/useThreadComposerSelection";
import { useThreadTargets } from "./hooks/useThreadTargets";
import type { useUserPreferences } from "./hooks/useUserPreferences";
import { usePanelLayout } from "./hooks/usePanelLayout";
import { useThreadSpace } from "./hooks/useThreadSpace";
import { useComposerRouting } from "./hooks/useComposerRouting";
import { useThreadEditing } from "./hooks/useThreadEditing";
import { useThreadNavigation } from "./hooks/useThreadNavigation";
import { useThreadTranscript } from "./hooks/useThreadTranscript";
import { myThreadSessions, pickActiveThreadSession } from "./lib/threads";
import { faviconState } from "./lib/faviconState";
import { useLiveFavicon } from "./hooks/useLiveFavicon";
import { shouldTailSessionEvents } from "./lib/sessionEventStream";
import { useUserProvisioning } from "./hooks/useUserProvisioning";
import { useLocalNodeAdoption } from "./hooks/useLocalNodeAdoption";
import { useUserAgents } from "./hooks/useUserAgents";
import { useTeams } from "./hooks/useTeams";
import { isAwaitingFeedbackDecision } from "./lib/workflow";
import { AppShell, RouteFallback } from "./components/AppShell";
import { ThreadsView } from "./components/ThreadsView";
import { OnboardingPanel } from "./components/onboarding/OnboardingPanel";
import { DefaultAgentsPrompt } from "./components/computer/DefaultAgentsPrompt";
import { useOnboarding } from "./hooks/useOnboarding";
import { SETUP_STEPS } from "./lib/onboarding";
import type { ComposerDispatchOptions, ComposerHandle } from "./components/composer/Composer";
import { latestThreadArtifacts, visibleThreadArtifacts } from "./lib/threadArtifacts";
import { resolveNewThreadComputer, threadOwnAgentId } from "./lib/threadRuntime";
import { navigateToAppPath } from "./lib/appRoute";
import { taskCreateIntent } from "./lib/taskCreateIntent";
import { showThreadChrome } from "./lib/projectPage";
import { useNotifications } from "./hooks/useNotifications";
import { computerManagementDestination, notificationHref, type NotificationTarget } from "./lib/notifications";
import { hrefForSettingsSection } from "./lib/appRoute";
import type { NotificationBellBinding } from "./components/notifications/NotificationBell";
import type { MobileView } from "./lib/viewTypes";

type UserPreferences = ReturnType<typeof useUserPreferences>;

interface AuthenticatedAppProps {
  user: CurrentUser;
  setUser: (user: CurrentUser | null) => void;
  /** Owned by the auth gate (App), which also needs them signed out. */
  preferences: UserPreferences;
}

// ── AuthenticatedApp ──────────────────────────────────────────────────────────

/** Everything behind sign-in. Loaded lazily by App, so a signed-out visitor
    downloads only the landing, sign-in, and waitlist screens. */
export function AuthenticatedApp({ user, setUser, preferences }: AuthenticatedAppProps) {
  const { t } = useTranslation();
  const { reportMutationError } = useMutationError();
  const {
    answerPermissionMutation,
    cancelRunMutation,
    recordDecisionMutation,
    runLogicalAgentsMutation,
    submitThreadMessageMutation,
    requestThreadRecoveryMutation,
  } = useRelayMutations();
  const selectedUser = useRelayStore((s) => s.selectedUser);
  const selectedSessionId = useRelayStore((s) => s.selectedSessionId);
  const tokens = useRelayStore((s) => s.tokens);
  const openSession = useRelayStore((s) => s.openSession);
  const startComposing = useRelayStore((s) => s.startComposing);
  const clearSelection = useRelayStore((s) => s.clearSelection);
  // True while the composer is staging a brand-new thread: suppresses the
  // fall-back to the most-recent session so the transcript shows the empty state
  // and the next send creates a fresh owner-scoped session.
  const composingNew = useRelayStore((s) => s.composingNew);
  const setComposingNew = useRelayStore((s) => s.setComposingNew);
  // Who the composer addresses. A team picked while staging a brand-new thread
  // is cleared the moment an existing thread opens or the pick is sent; a
  // project thread talks to the whole roster until one member is picked.
  const chosenExecutor = useComposerTargetStore((s) => s.activeAgent);
  const chosenAgentId = useComposerTargetStore((s) => s.activeLogicalAgentId);
  const pendingThreadTeamId = useComposerTargetStore((s) => s.pendingThreadTeamId);
  const projectRoomTarget = useComposerTargetStore((s) => s.projectRoomTarget);
  const newThreadNodeId = useComposerTargetStore((s) => s.newThreadNodeId);
  const setNewThreadNodeId = useComposerTargetStore((s) => s.setNewThreadNodeId);
  const pickAgent = useComposerTargetStore((s) => s.pickAgent);
  const pickTeam = useComposerTargetStore((s) => s.pickTeam);
  const pickRoom = useComposerTargetStore((s) => s.pickRoom);
  const restoreThreadPick = useComposerTargetStore((s) => s.restoreThreadPick);
  const rememberThreadPick = useComposerTargetStore((s) => s.rememberThreadPick);
  const clearPendingTeam = useComposerTargetStore((s) => s.clearPendingTeam);
  const dropPendingMessage = useThreadSendStore((s) => s.dropPendingMessage);
  const [threadQuery, setThreadQuery] = useState("");
  const mounted = useClientMounted();
  const panels = usePanelLayout(mounted);
  const { agents: logicalAgents, isSuccess: agentsReady } = useUserAgents(user.userId);
  const { teams, isSuccess: teamsReady } = useTeams(user.userId);
  const composerRef = useRef<ComposerHandle>(null);
  const messageOperationIdsRef = useRef(new Map<string, string>());
  const recoveryOperationIdsRef = useRef(new Map<string, string>());

  const selectedUserToken = tokens[selectedUser];
  const {
    sandboxes,
    nodes,
    nodesReady,
    sessions,
    tasks,
    projects,
    projectsStatus,
    tasksStatus,
    projectsError,
    isRefreshing,
    refresh,
    setSandboxes,
  } = useRelayData(selectedUserToken, true);
  const { localNodes, refreshLocalDaemonNodes } = useLocalDaemonNodes(
    user.role === "admin" && canUseLocalControlPanel(),
  );
  const visibleNodes = useMemo(() => mergeVisibleDaemonNodes(nodes, localNodes), [nodes, localNodes]);
  const runtimeNodes = useMemo(
    () => mergeThreadRuntimeNodes(nodes, localNodes),
    [localNodes, nodes],
  );
  const selectedSandbox = useMemo(() => sandboxes.find((s) => s.userId === selectedUser), [sandboxes, selectedUser]);
  // The logged-in user's threads are the
  // sessions they own. The backend already owner-scopes /api/v1/threads, so this is
  // just the non-archived sessions sorted most-recent first.
  const myThreads = useMemo(
    () => myThreadSessions(sessions, selectedUser),
    [sessions, selectedUser],
  );
  // Home's queue, computed once: Home renders it and the rail badges it.
  const homeItems = useMemo(
    () => homeQueue({
      tasks,
      sessions,
      nodes: runtimeNodes,
      userId: selectedUser,
      today: isoToday(),
      snoozes: user.homeSnoozes,
    }),
    [runtimeNodes, selectedUser, sessions, tasks, user.homeSnoozes],
  );
  const homeNeedsYou = homeNeedsYouCount(homeItems);
  const onboarding = useOnboarding({
    user,
    setUser,
    nodes: runtimeNodes,
    agents: logicalAgents,
    threads: myThreads,
  });
  const { activeSessionId } = useActiveSession(selectedUser, myThreads);
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
    selectedUser,
    teams,
  });

  const visibleArtifacts = useMemo(() => visibleThreadArtifacts(activeSession), [activeSession]);
  const threadFileCount = useMemo(() => latestThreadArtifacts(visibleArtifacts).length, [visibleArtifacts]);

  useEffect(() => {
    if (!initializingThread) return;
    setNewThreadNodeId((previous) => resolveNewThreadComputer(previous, threadComputers, assignableComputers));
  }, [assignableComputers, initializingThread, setNewThreadNodeId, threadComputers]);

  const composerTeamIds = useMemo(() => composerTeams.map((team) => team.id), [composerTeams]);
  const threadAgent = useMemo(() => {
    const id = threadOwnAgentId(activeSession);
    const agent = id ? logicalAgents.find((candidate) => candidate.id === id) : undefined;
    return agent ? { id: agent.id, executorKind: agent.executorKind } : null;
  }, [activeSession, logicalAgents]);
  useThreadComposerSelection({
    sessionId: activeSession?.id,
    composingNew,
    targetsReady: agentsReady && teamsReady && nodesReady,
    teamIds: composerTeamIds,
    threadAgent,
  });

  const applySessionFromHash = useCallback((sessionId: string) => {
    restoreThreadPick(sessionId);
    openSession(sessionId);
  }, [openSession, restoreThreadPick]);

  const setComposingNewFromPath = useCallback((next: boolean) => {
    if (next) startComposing();
    else setComposingNew(false);
  }, [setComposingNew, startComposing]);

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
    onClearPendingMessage: dropPendingMessage,
  });
  /* The inbox. A computer notice opens wherever that computer is managed:
     the person's own Computers page for a machine they hold, the control panel
     for shared hardware an admin is told about. */
  const ownNodeIds = useMemo(
    () => new Set(nodes.filter((node) => node.userId === user.userId).map((node) => node.id)),
    [nodes, user.userId],
  );
  const computerDestination = useCallback(
    (nodeId: string) => computerManagementDestination(nodeId, { isAdmin: user.role === "admin", ownNodeIds }),
    [ownNodeIds, user.role],
  );
  const openTaskRecord = useStableEvent(({ taskId, routineId }: { taskId: string; routineId?: string }) => {
    if (routineId) navigateToRoutineRecord(routineId, taskId);
    else navigateToTaskRecord(taskId);
  });
  const openNotice = useStableEvent(({ target }: { target: NotificationTarget }) => {
    if (target.kind === "task") {
      if (target.routineId) navigateToRoutineRecord(target.routineId, target.taskId);
      else navigateToTaskRecord(target.taskId);
      return;
    }
    if (target.kind === "thread") {
      // A paused run's prompt sits in its thread's transcript; open it there.
      void navigateToAppPath(notificationHref(target));
      return;
    }
    if (computerDestination(target.nodeId) === "admin") navigateToAdminSection("computers");
    else navigateToRoute("computers");
  });
  const notificationController = useNotifications({
    // Session-cookie authenticated, so every signed-in account has an inbox —
    // a bootstrap admin without a User files notices under its account.
    enabled: true,
    onOpen: openNotice,
  });
  const notificationBell = useMemo<NotificationBellBinding>(() => ({
    controller: notificationController,
    hrefFor: (target) => notificationHref(target, target.kind === "computer" ? computerDestination(target.nodeId) : undefined),
    settingsHref: hrefForSettingsSection("notifications"),
    onOpenSettings: () => navigateToSettings("notifications"),
  }), [computerDestination, navigateToSettings, notificationController]);
  const activeProject = useMemo(() => {
    const id = routedProjectId ?? activeSession?.projectId;
    return id ? projects.find((project) => project.id === id) ?? null : null;
  }, [activeSession?.projectId, projects, routedProjectId]);
  const projectRoom = useMemo(
    () => (activeProject
      ? {
          agentIds: projectRoomAgentIds(activeProject, activeSession),
          crewAgentIds: activeProject.members.filter((member) => member.enabled).map((member) => member.agentId),
        }
      : null),
    [activeProject, activeSession],
  );
  const projectDispatchDisabled = Boolean(
    activeProject && (activeProject.archivedAt || !activeProject.enabled),
  );
  const {
    effectiveSelectableLogicalAgents,
    composerLogicalAgents,
    activeLogicalAgentId,
    activeAgent,
    threadMentionCandidates,
    requiresRuntimeSelection,
    roundTeamId,
  } = useComposerRouting({
    activeSession,
    activeProject,
    teams,
    logicalAgents,
    selectableLogicalAgents,
    initializingThread,
    chosenExecutor,
    chosenAgentId,
    pendingThreadTeamId,
    projectRoomTarget,
  });
  const showProjectOverview = route === "projects"
    && Boolean(routedProjectId)
    && !routedSessionId
    && !composingNew;
  const showProjectDirectoryEmpty = route === "projects"
    && !routedProjectId
    && !routedSessionId
    && !composingNew;
  const isTaskThread = route === "backlog" && Boolean(recordTaskId && routedSessionId);
  const isTasksWorkspace = route === "backlog" && !isTaskThread;
  const detailAgent = useMemo(
    () => logicalAgents.find((agent) => agent.id === agentId) ?? null,
    [agentId, logicalAgents],
  );

  // Whether the content area is a thread surface — the threads view, a
  // project room, or a task's thread. `pickActiveThreadSession` falls back to
  // the newest thread, so without this gate a run in that thread would stream
  // frames, and re-render everything here, under the Issues or Admin page.
  const threadSurfaceVisible = !showsWorkRoutePage(route, notFound, isTaskThread);
  // A phone shows the thread list OR the conversation, never both, so on the
  // list the fallback thread has no transcript on screen to keep fresh.
  const isPhone = useMediaQuery(OVERLAY_TAKEOVER_QUERY);
  const transcriptVisible = threadSurfaceVisible && !(isPhone && mobileView === "threads");

  // Full detail plus the live SSE tail of the open thread, merged into the
  // sessions cache so it updates at push latency — only while it is shown.
  useSessionDetail(activeSession?.id, transcriptVisible);
  useSessionEvents(activeSession?.id, transcriptVisible && shouldTailSessionEvents(activeSession?.status));

  const selectedToken = selectedSandbox ? (tokens[selectedSandbox.id] ?? tokens[selectedUser]) : tokens[selectedUser];
  const {
    activeRunOwner,
    activeRun,
    pendingUserMessage,
    threadRunning,
    displayMessages,
    transcript,
  } = useThreadTranscript(activeSession, visibleNodes, t);

  const activeThreadLabel = showProjectOverview && activeProject
    ? activeProject.name
    : activeSession
      ? (activeSession.title?.trim() || activeSession.taskGoal)
      : t("thread.new_thread");

  const skipLinkHref = skipLinkTarget({
    route,
    mobileView,
    notFound,
    taskThread: isTaskThread,
    projectOverview: showProjectOverview,
    agentId,
  });

  const awaitingDecision = useMemo(() => isAwaitingFeedbackDecision(activeSession), [activeSession]);

  const threadChromeVisible = showThreadChrome(isTasksWorkspace || showProjectOverview || showProjectDirectoryEmpty);
  const spaceVisible = threadChromeVisible
    && (route === "main" || route === "projects" || isTaskThread)
    && space.open
    && Boolean(activeSession);

  const { directoryProjects, directoryThreads, threadItems } = useThreadDirectory({
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
  // The tab's mark lights the half that is acting: blue while an agent
  // works, orange when a thread needs you, dark at rest.
  const tabState = useMemo(() => faviconState(threadItems, tasks), [threadItems, tasks]);
  useLiveFavicon(tabState);

  const refreshWithToken = useCallback(async (tokenOverride?: string) => {
    await refresh(undefined, tokenOverride);
  }, [refresh]);

  const { adoptLocalDaemonNodes } = useUserProvisioning({
    nodes,
    setSandboxes,
    refreshLocalDaemonNodes,
    refreshWithToken,
  });

  useLocalNodeAdoption(user.role === "admin" && canUseLocalControlPanel(), adoptLocalDaemonNodes);
  // Admin local-node polling now lives in useLocalDaemonNodes (refetchInterval).
  useEffect(() => {
    if (selectedUser) {
      localStorage.setItem(selectedUserKey, selectedUser);
      localStorage.removeItem(legacySelectedUserKey);
    } else {
      localStorage.removeItem(selectedUserKey);
    }
  }, [selectedUser]);
  // Keep the handoff target routable as the thread's roster changes.
  useEffect(() => {
    if (effectiveSelectableLogicalAgents.length === 0) return;
    const { agentId, setAgentId } = useHandoffStore.getState();
    if (effectiveSelectableLogicalAgents.some((agent) => agent.id === agentId && isUserAgentRoutable(agent))) return;
    setAgentId(effectiveSelectableLogicalAgents.find(isUserAgentRoutable)?.id ?? "");
  }, [effectiveSelectableLogicalAgents]);
  useEffect(() => {
    if ((route === "admin" || route === "channels") && user.role !== "admin") {
      navigateToRoute("main");
    }
  }, [navigateToRoute, route, user.role]);
  const { openThread, startNewThread, selectProject } = useThreadNavigation({
    route,
    myThreads,
    tasks,
    tasksStatus,
    activeSession,
    composingNew,
    routedSessionId,
    routedProjectId,
    recordTaskId,
    threadComputers,
    assignableComputers,
    composerRef,
    pinTranscriptToBottom: transcript.pinToBottom,
    showThreadList: () => space.setThreadListHidden(false),
    syncThreadUrl,
    navigateToProject,
  });

  // The rail chip and the palette's "Get started" both land here: a fresh
  // thread is the empty transcript the wizard lives in, and a dismissed
  // wizard is brought back first.
  const openOnboarding = useStableEvent(() => {
    if (!onboarding.progress.visible) onboarding.reopen();
    startNewThread();
  });
  const onboardingPanel = onboarding.progress.visible && route === "main" && user.userId ? (
    <OnboardingPanel
      controls={onboarding}
      userId={user.userId}
      onUseStarter={(text, target) => {
        if (target) {
          setNewThreadNodeId(target.nodeId);
          pickAgent(target.agent);
        }
        composerRef.current?.setText(text);
        composerRef.current?.focus();
      }}
      onOpenRoute={navigateToRoute}
      onOpenComputers={() => navigateToRoute("computers")}
      onChanged={() => void refresh()}
    />
  ) : null;

  const { renameThread, deleteThread } = useThreadEditing({
    threads: myThreads,
    activeSessionId: activeSession?.id,
    token: selectedToken,
    onActiveThreadDeleted: () => {
      clearSelection();
      navigateToRoute("main");
    },
    t,
  });

  const {
    sendMessage,
    cancelActiveRun,
    sendDecision,
    retryAgentMessage,
    resumeAgentMessage,
    sendHandoff,
  } = useThreadDispatch({
    activeSession, activeProject, activeRun, activeRunOwner, activeRuntimeNode,
    threadRunning, requiresRuntimeSelection, projectDispatchDisabled,
    effectiveSelectableLogicalAgents,
    composerLogicalAgents,
    threadMentionCandidates, composerTeams,
    selectedUser, selectedSandbox, selectedThreadNodeId, selectedToken, tokens,
    composerRef, transcript,
    messageOperationIdsRef, recoveryOperationIdsRef,
    submitThreadMessageMutation, runLogicalAgentsMutation, requestThreadRecoveryMutation,
    recordDecisionMutation, cancelRunMutation,
    syncThreadUrl, navigateToRoute,
    reportMutationError, t,
  });

  const handleComposerSend = useStableEvent((style?: CollaborationStyle, intent?: ThreadMessageInput["intent"], options?: ComposerDispatchOptions) => sendMessage(style, intent, options));
  const handleCancelRun = useStableEvent(() => { void cancelActiveRun(); });
  const handleAnswerPermission = useStableEvent(async (requestId: string, answer: PermissionAnswerInput) => {
    if (!activeSession) return;
    try {
      await answerPermissionMutation.mutateAsync({ sessionId: activeSession.id, requestId, answer, token: selectedToken });
    } catch {
      // mutation onError surfaces a toast.
    }
  });
  const handleRetryAgent = useStableEvent((agent: AgentName, agentId?: string) => { void retryAgentMessage(agent, agentId); });
  const handleResumeAgent = useStableEvent((agent: AgentName, agentId?: string) => { void resumeAgentMessage(agent, agentId); });
  const handleOpenThreadSpace = useStableEvent((artifact?: RelayArtifact) => space.openSpace(artifact?.id ?? null));
  // A pick in a started thread is remembered for it, so reopening the thread
  // keeps the last choice rather than resetting to the whole team.
  const rememberPick = () => {
    if (!requiresRuntimeSelection && activeSession) rememberThreadPick(activeSession.id);
  };
  const handleProjectRoomPicked = useStableEvent(() => {
    pickRoom();
    rememberPick();
  });
  // Picking one member narrows a project round to them and drops a staged team.
  const handleLogicalAgentPicked = useStableEvent((agent: UserAgent) => {
    pickAgent(agent);
    rememberPick();
  });
  // Re-picking a team thread's own team is picking its room, not naming it.
  const handleTeamPicked = useStableEvent((team: AgentTeam) => {
    if (!requiresRuntimeSelection && team.id === activeSession?.teamId) {
      clearPendingTeam();
      pickRoom();
    } else {
      pickTeam(team.id);
    }
    rememberPick();
  });

  const handleLogout = useStableEvent(async () => {
    preferences.invalidate(null);
    try {
      await logout();
    } catch {
      // ignore
    }
    setUser(null);
    navigateToLogin(true);
  });
  // Identity-stable handlers and values for the shell's memoized leaves and
  // the memoized work page: a new function per render would make every
  // streamed frame re-render the nav, the palette, and whichever page is open.
  const onLogout = useStableEvent(() => { void handleLogout(); });
  const onMobileViewChange = useStableEvent((view: MobileView) => {
    if (view === "threads" && showProjectOverview) navigateToProject(null);
    else navigateToMobileView(view);
  });
  const onNewTask = useStableEvent(() => {
    taskCreateIntent()?.queue();
    // The queued intent is picked up by the tasks board, which is no
    // longer the project's default tab — ask for it by name.
    if (showProjectOverview && routedProjectId) void navigateToAppPath(`/projects/${encodeURIComponent(routedProjectId)}?tab=tasks`);
    else if (route !== "backlog") navigateToRoute("backlog");
  });
  const onRefresh = useStableEvent(() => refresh());
  // useThreadNavigation hands back plain closures; the memoized work page
  // needs one identity for the life of the shell.
  const onOpenThread = useStableEvent(openThread);
  const onGoHome = useStableEvent(() => navigateToRoute("home"));
  const onboardingBadge = useMemo(
    () => (onboarding.progress.visible ? { done: onboarding.progress.completedCount, total: SETUP_STEPS.length } : null),
    [onboarding.progress.completedCount, onboarding.progress.visible],
  );

  return (
    <AppShell
      route={route}
      taskWorkspace={isTasksWorkspace}
      taskThread={isTaskThread}
      onNavigateRoute={navigateToRoute}
      hrefForRoute={hrefForSideNavRoute}
      mobileView={mobileView}
      onMobileViewChange={onMobileViewChange}
      sidenavExpanded={panels.sidenavExpanded}
      setSidenavExpanded={panels.setSidenavExpanded}
      sidenavWidth={panels.sidenavWidth}
      sidenavResizing={panels.sidenavResizing}
      onSidenavResize={panels.resizeSidenav}
      onSidenavResizeActive={panels.setSidenavResizing}
      skipLinkHref={skipLinkHref}
      activeThreadLabel={activeThreadLabel}
      threadSpaceOpen={spaceVisible}
      threadSpaceWidth={panels.spaceWidth}
      threadSpaceResizing={panels.spaceResizing}
      threadListHidden={isTaskThread || space.threadListHidden}
      threadListWidth={panels.threadListWidth}
      threadListResizing={panels.threadListResizing}
      mobileChatChrome={threadChromeVisible ? {
        artifactCount: threadFileCount,
        inProject: Boolean(activeSession?.projectId),
        spaceOpen: spaceVisible,
        spaceDisabled: !activeSession,
        onToggleSpace: space.toggleSpace,
      } : null}
      user={user}
      onLogout={onLogout}
      onNewThread={startNewThread}
      onboarding={onboardingBadge}
      homeNeedsYou={homeNeedsYou}
      onOpenOnboarding={openOnboarding}
      notifications={notificationBell}
      onNewTask={onNewTask}
      theme={preferences.theme}
      onThemeChange={preferences.setTheme}
    >
      <ScreenErrorBoundary resetKey={`${route}:${routedSessionId}:${routedProjectId}:${agentId}:${recordTaskId}:${recordRunId}:${teamWorkspaceId}`}>
      <Suspense fallback={<RouteFallback />}>
        {showsWorkRoutePage(route, notFound, isTaskThread) ? (
          <WorkRoutePage
            route={route}
            notFound={notFound}
            user={user}
            projects={projects}
            projectsStatus={projectsStatus}
            tasks={tasks}
            sessions={sessions}
            homeItems={homeItems}
            selectedUser={selectedUser}
            setUser={setUser}
            visibleNodes={visibleNodes}
            runtimeNodes={runtimeNodes}
            isRefreshing={isRefreshing}
            onRefresh={onRefresh}
            onOpenThread={onOpenThread}
            onGoHome={onGoHome}
            adminSection={adminSection}
            onSelectAdminSection={navigateToAdminSection}
            recordTaskId={recordTaskId}
            recordRunId={recordRunId}
            onOpenTaskRecord={navigateToTaskRecord}
            onOpenRoutineRecord={navigateToRoutineRecord}
            teamWorkspaceId={teamWorkspaceId}
            onSelectTeam={navigateToTeamWorkspace}
            detailAgent={detailAgent}
            onOpenAgent={navigateToAgent}
            settingsSection={settingsSection}
            onSelectSettingsSection={navigateToSettings}
            theme={preferences.theme}
            onThemeChange={preferences.setTheme}
            language={preferences.language}
            onLanguageChange={preferences.setLanguage}
          />
        ) : (
          <ThreadsView
            onOpenTaskRecord={openTaskRecord}
            taskThread={isTaskThread}
            directoryMode={route === "projects" ? "projects" : "threads"}
            tasks={tasks}
            currentUser={user}
            onboardingPanel={onboardingPanel}
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
            composerLogicalAgents={composerLogicalAgents}
            activeLogicalAgentId={activeLogicalAgentId}
            onLogicalAgentPicked={handleLogicalAgentPicked}
            composerTeams={composerTeams}
            activeTeamId={roundTeamId}
            onTeamPicked={handleTeamPicked}
            artifactCount={threadFileCount}
            visibleArtifacts={visibleArtifacts}
            spaceOpen={spaceVisible}
            spaceArtifactId={space.artifactId}
            spaceWidth={panels.spaceWidth}
            threadListHidden={isTaskThread || space.threadListHidden}
            threadListWidth={panels.threadListWidth}
            onThreadListResize={panels.resizeThreadList}
            onThreadListResizeActive={panels.setThreadListResizing}
            onOpenArtifacts={handleOpenThreadSpace}
            onToggleSpace={space.toggleSpace}
            onCloseSpace={space.closeSpace}
            onSelectSpaceArtifact={space.selectArtifact}
            onSpaceResize={panels.resizeSpace}
            onSpaceResizeActive={panels.setSpaceResizing}
            onToggleThreadList={() => space.setThreadListHidden(!space.threadListHidden)}
            onBackToThreads={() => navigateToMobileView("threads")}
            selectedUser={selectedUser}
            initializingThread={requiresRuntimeSelection}
            projectName={activeProject?.name}
            projectRoom={projectRoom}
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
            sendDecision={sendDecision}
            sendHandoff={sendHandoff}
            onAnswerPermission={handleAnswerPermission}
            onSend={handleComposerSend}
            onCancelRun={handleCancelRun}
            onRetryAgent={handleRetryAgent}
            onResumeAgent={handleResumeAgent}
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
      {/* A connecting computer asks, once, whether to create a default agent
          per ready runtime it brought. */}
      {user.userId ? <DefaultAgentsPrompt userId={user.userId} /> : null}
    </AppShell>
  );
}
