"use client";

import { lazy, Suspense, useCallback, useEffect, useMemo, useState, type Dispatch, type ReactNode, RefObject, SetStateAction } from "react";
import { useTranslation } from "react-i18next";
import {
  ActionRoute,
  ICON,
} from "./icons";
import { RelayMark } from "./RelayMark";
import type { AgentName, AgentTeam, CurrentUser, DaemonNodeMonitorRecord, UserAgent, ProjectRecord, RelayArtifact, RelaySession, RelayTaskListItem } from "../types";
import type { PermissionAnswerInput } from "../lib/permissionRequests";
import {
  buildExecutorDisplayNameMap,
  buildLogicalAgentImageMap,
  buildLogicalAgentNameMap,
  displayNameForExecutor,
  labelForAgentRun,
} from "../lib/agentDisplayNames";
import { preloadMarkdown } from "./LazyMarkdown";
import { threadAgentName } from "../lib/threadBand";
import { useTranscriptWindow } from "../hooks/useTranscriptWindow";
import { useRelayStore } from "../lib/store";
import { threadSendKey } from "../lib/threadSendStore";
import { threadDraftKey } from "../hooks/useComposer";
import { useThreadQueue } from "../hooks/useThreadQueue";
import { MessageQueue } from "./composer/MessageQueue";
import type { ThreadItem } from "./ThreadRow";
import type { MentionCandidate } from "../lib/mentions";
import { ThreadListPanel, type ThreadListPaging } from "./ThreadListPanel";
import type { ThreadProjectFilter, ThreadProjectOption } from "../lib/threadProjectFilter";
import { ExecutionRecoveryPanel } from "./ExecutionRecoveryPanel";
import { QueuedRunCard } from "./QueuedRunCard";
import { queuedRun } from "../lib/queuedRun";
import { AwaitingInputPrompt } from "./AwaitingInputPrompt";
import { NextSteps } from "./NextSteps";
import { awaitingInput } from "../lib/awaitingInput";
import { threadNextSteps } from "../lib/nextSteps";
import { ThreadHeader } from "./ThreadHeader";
import { ThreadMeta } from "./ThreadMeta";
import { TranscriptEmpty } from "./TranscriptEmpty";
import { greetingName } from "../lib/welcomeRecap";
import { useTaskThreadLifecycle, type OpenTaskRecord } from "../hooks/useTaskThreadLifecycle";
import { useTaskStatusActions } from "../hooks/useTaskStatusActions";
import { TaskStatusTimeline } from "./TaskStatusTimeline";
import { TaskActionBar, taskNeedsAction } from "./TaskActionBar";
import { TaskReviewPanel } from "./task-record/TaskReviewPanel";
import { MessageBlock, isGroupedContinuation, type DerivedMessage } from "./MessageBlock";
import { DirectDelegationCard } from "./DirectDelegationCard";
import { directDelegations } from "../lib/directDelegations";
import { handoffSource, phaseDividerLabel } from "../lib/projectMessages";
import { parseAutomationOpening } from "../lib/automationOpening";
import { threadOriginIndex } from "../lib/threads";
import { threadPanelLayout } from "../lib/threadPanel";
import { resolveProjectOverviewState, type ProjectCollectionStatus } from "../lib/projectPage";
import { HandoffStatus } from "./HandoffStatus";
import { TeamHandoffCue } from "./TeamHandoffCue";
import { styleForRun, turnSlot } from "../lib/collaborationStyle";
import { CollaborationStatus } from "./CollaborationStatus";
import { RunStartingCue } from "./RunStartingCue";
import { ProjectSetupCue } from "./ProjectSetupCue";
import { ProjectManagerProposals } from "./ProjectManagerProposals";
import { DecisionBar } from "./composer/DecisionBar";
import { PermissionPrompts } from "./composer/PermissionPrompts";
import { openPermissionRequests } from "../lib/permissionRequests";
import { Composer, type ComposerHandle } from "./composer/Composer";
import type { ProjectRoomOption } from "./composer/AgentSelect";
import { ThreadSpacePanel } from "./space/ThreadSpacePanel";
import { buildSpaceItems, threadHasMultipleProducers } from "../lib/threadSpace";
import { latestThreadArtifacts } from "../lib/threadArtifacts";
import { ProjectDrawer } from "./ProjectDrawer";
// The project page carries the whole task board (records, board, filters,
// date picker); load it with the first project opened, not with every thread.
const ProjectWorkspacePage = lazy(() => import("./ProjectWorkspacePage").then((m) => ({ default: m.ProjectWorkspacePage })));
import { RelayEmptyState } from "./RelayEmptyState";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/** The project pane while its record, or the page's own code, is on the way. */
function ProjectLoadingState() {
  const { t } = useTranslation();
  return (
    <section
      id="project-detail-panel"
      className="chat-panel project-directory-empty project-route-state"
      aria-label={t("project.loading")}
      aria-busy="true"
      role="status"
      tabIndex={-1}
    >
      <RelayEmptyState feature="projects"
        fill
        title={t("project.loading")}
        body={t("project.loading_body")}
      />
    </section>
  );
}

type ThreadsViewProps = {
  workspaceNavigation?: ReactNode;
  taskThread?: boolean;
  /** On a phone, the list pane is the one showing (mobile view "threads"). */
  listOnScreen: boolean;
  directoryMode: "threads" | "projects";
  /** The shell's task list — the project board reads its lanes from it
   *  rather than opening a second observer on the same query. */
  tasks: RelayTaskListItem[];
  currentUser: CurrentUser;
  /** The onboarding wizard, shown instead of the empty transcript while the
   *  person is still setting up. */
  onboardingPanel?: ReactNode;
  filteredThreads: ThreadItem[];
  projects: ProjectRecord[];
  selectedProjectId: string | null;
  projectsStatus: ProjectCollectionStatus;
  projectsError: string;
  onRetryProjects: () => void;
  showProjectOverview: boolean;
  showProjectDirectoryEmpty: boolean;
  threadQuery: string;
  setThreadQuery: Dispatch<SetStateAction<string>>;
  threadProjectFilter: ThreadProjectFilter;
  threadProjectOptions: readonly ThreadProjectOption[];
  onThreadProjectFilterChange: (filter: ThreadProjectFilter) => void;
  activeSession: RelaySession | undefined;
  pendingUserMessage: { id: string; text: string } | null;
  displayMessages: DerivedMessage[];
  awaitingDecision: boolean;
  transcriptRef: (node: HTMLDivElement | null) => void;
  composerRef: RefObject<ComposerHandle | null>;
  onTranscriptScroll: () => void;
  onSelectThread: (sessionId: string) => void;
  onSelectProject: (projectId: string | null) => void;
  onNewThread: (projectId?: string | null) => void;
  onRenameThread: (session: RelaySession) => void;
  onCloseThread: (sessionId: string) => void;
  activeAgent: AgentName;
  logicalAgents: UserAgent[];
  /** Who recovery (rerun / handoff) may reach — a team thread's own roster. */
  selectableLogicalAgents: UserAgent[];
  /** Who a new round may reach — every agent on the thread's computer. */
  composerLogicalAgents: UserAgent[];
  activeLogicalAgentId: string | null;
  onLogicalAgentPicked: (agent: UserAgent) => void;
  composerTeams: AgentTeam[];
  activeTeamId: string | null;
  onTeamPicked: (team: AgentTeam) => void;
  artifactCount: number;
  visibleArtifacts: RelayArtifact[];
  spaceOpen: boolean;
  spaceArtifactId: string | null;
  spaceWidth: number;
  threadListHidden: boolean;
  threadListWidth: number;
  onThreadListResize: (width: number, commit: boolean) => void;
  onThreadListResizeActive: (active: boolean) => void;
  onOpenArtifacts: (artifact?: RelayArtifact) => void;
  onToggleSpace: () => void;
  onCloseSpace: () => void;
  onSelectSpaceArtifact: (artifactId: string | null) => void;
  onSpaceResize: (width: number, commit: boolean) => void;
  onSpaceResizeActive: (active: boolean) => void;
  onToggleThreadList: () => void;
  onBackToThreads: () => void;
  selectedUser: string;
  initializingThread: boolean;
  /** The thread list has not arrived, so no thread is known to be missing:
   *  the page holds its docked shape rather than drawing the new-thread
   *  landing it would only snap out of. */
  threadsLoading?: boolean;
  threadLoadError?: string | null;
  onRetryThread?: () => void;
  /** Older pages of the thread list, loaded as the rail reaches its end. */
  threadPaging?: ThreadListPaging;
  /** The thread's project has not loaded, so its composer cannot yet say
   *  whether it addresses the project room or a team. */
  projectLoading?: boolean;
  projectName?: string;
  /** The project's roster offered as one composer target. */
  projectRoom?: ProjectRoomOption | null;
  projectRoomSelected?: boolean;
  onProjectRoomPicked?: () => void;
  projectReadOnly?: boolean;
  runtimeNodes: DaemonNodeMonitorRecord[];
  runtimeNodeId: string | null;
  selectedRuntimeNode: DaemonNodeMonitorRecord | null;
  activeRuntimeNode: DaemonNodeMonitorRecord | null;
  /** Agents `@` may name in this thread. */
  mentionCandidates: MentionCandidate[];
  /** Agents in the thread's room, resolved for the header strip. */
  threadParticipants: UserAgent[];
  onRuntimeNodeChange: (nodeId: string) => void;
  sendDecision: (kind: "approve" | "reject" | "rerun" | "mark_done") => Promise<boolean>;
  sendHandoff: () => Promise<void>;
  /** Answer a live run's runtime permission prompt. */
  onAnswerPermission: (requestId: string, answer: PermissionAnswerInput) => Promise<void>;
  onSend: (style?: import("../types").CollaborationStyle, intent?: import("../types").ThreadMessageInput["intent"], options?: import("./composer/Composer").ComposerDispatchOptions) => void | Promise<boolean | void>;
  onCancelRun: () => void;
  onRetryAgent: (agent: AgentName, agentId?: string) => void;
  onResumeAgent: (agent: AgentName, agentId?: string) => void;
  onRetryExecutionRecovery?: () => Promise<void>;
  onReportExecutionGone?: () => Promise<void>;
  /** Opens the record of the task a thread works on. */
  onOpenTaskRecord: OpenTaskRecord;
  running: boolean;
};

export function ThreadsView({
  workspaceNavigation,
  taskThread = false,
  listOnScreen,
  directoryMode,
  tasks,
  currentUser,
  onboardingPanel,
  filteredThreads,
  projects,
  selectedProjectId,
  projectsStatus,
  projectsError,
  onRetryProjects,
  showProjectOverview,
  showProjectDirectoryEmpty,
  threadQuery,
  setThreadQuery,
  threadProjectFilter,
  threadProjectOptions,
  onThreadProjectFilterChange,
  activeSession,
  pendingUserMessage,
  displayMessages,
  awaitingDecision,
  transcriptRef,
  composerRef,
  onTranscriptScroll,
  onSelectThread,
  onSelectProject,
  onNewThread,
  onRenameThread,
  onCloseThread,
  activeAgent,
  logicalAgents,
  selectableLogicalAgents,
  composerLogicalAgents,
  activeLogicalAgentId,
  onLogicalAgentPicked,
  composerTeams,
  activeTeamId,
  onTeamPicked,
  artifactCount,
  visibleArtifacts,
  spaceOpen,
  spaceArtifactId,
  spaceWidth,
  threadListHidden,
  threadListWidth,
  onThreadListResize,
  onThreadListResizeActive,
  onOpenArtifacts,
  onToggleSpace,
  onCloseSpace,
  onSelectSpaceArtifact,
  onSpaceResize,
  onSpaceResizeActive,
  onToggleThreadList,
  onBackToThreads,
  selectedUser,
  initializingThread,
  threadsLoading = false,
  threadLoadError = null,
  onRetryThread,
  threadPaging,
  projectLoading = false,
  projectName,
  projectRoom,
  projectRoomSelected,
  onProjectRoomPicked,
  projectReadOnly,
  runtimeNodes,
  runtimeNodeId,
  selectedRuntimeNode,
  activeRuntimeNode,
  mentionCandidates,
  threadParticipants,
  onRuntimeNodeChange,
  sendDecision,
  sendHandoff,
  onAnswerPermission,
  onSend,
  onCancelRun,
  onRetryAgent,
  onResumeAgent,
  onRetryExecutionRecovery,
  onReportExecutionGone,
  onOpenTaskRecord,
  running,
}: ThreadsViewProps) {
  const { t } = useTranslation();
  const runSlots = useMemo(() => new Map((activeSession?.agentRuns ?? []).map((run) => [
    run.id, turnSlot(run, styleForRun(run, activeSession?.collaborationRounds)),
  ])), [activeSession?.agentRuns, activeSession?.collaborationRounds]);
  const fallbackRuns = useMemo(() => new Set((activeSession?.collaborationRounds ?? [])
    .filter((round) => round.styleFallbackFrom)
    .map((round) => activeSession?.agentRuns.find((run) => run.assignmentId === round.assignments[0]?.assignmentId)?.id)),
  [activeSession?.agentRuns, activeSession?.collaborationRounds]);
  const delegations = useMemo(() => directDelegations(activeSession), [activeSession]);
  // An automation run's first turn draws as the automation's card. A fired
  // run says so in its goal's trigger block; a scheduled one carries none, so
  // the task list is what marks the thread as a routine occurrence.
  const threadDraftId = useRelayStore((s) => s.threadDraftId);
  const activeSessionId = activeSession?.id;
  const activeTaskGoal = activeSession?.taskGoal;
  const automationOpening = useMemo(() => {
    if (!activeSessionId || activeTaskGoal === undefined) return null;
    const scheduled = threadOriginIndex(tasks).get(activeSessionId)?.kind === "routine";
    return parseAutomationOpening(activeTaskGoal, { scheduled });
  }, [activeSessionId, activeTaskGoal, tasks]);
  // The thread's task: its status in the header, and each status change it
  // went through listed in the side panel — never between the turns.
  const lifecycle = useTaskThreadLifecycle({
    tasks,
    session: activeSession,
    currentUserId: currentUser.userId,
    onOpenTaskRecord,
  });
  const taskStatusActions = useTaskStatusActions(lifecycle.task?.id);
  const [projectDrawerOpen, setProjectDrawerOpen] = useState(false);
  const { start: transcriptStart, sentinelRef } = useTranscriptWindow(activeSession?.id, displayMessages.length);
  // A thread is about to render markdown: start the pipeline download now so
  // the first turn rarely shows its plain-text fallback. A brand-new empty
  // thread renders none, so it waits for its first turn (or the run that
  // will produce it) before fetching the pipeline. While the thread list is
  // still loading, a thread is the likely outcome: fetching alongside it is
  // what keeps a deep link's turns from painting as plain text and then
  // reflowing once the pipeline lands.
  const hasTranscript = Boolean(activeSession) && (running || displayMessages.length > 0
    || (activeSession?.events.length ?? 0) > 0 || (activeSession?.agentRuns.length ?? 0) > 0);
  const transcriptLikely = hasTranscript || threadsLoading;
  useEffect(() => {
    if (transcriptLikely) preloadMarkdown();
  }, [transcriptLikely]);
  const agentDisplayNames = useMemo(() => buildExecutorDisplayNameMap(logicalAgents), [logicalAgents]);
  const logicalAgentNames = useMemo(() => buildLogicalAgentNameMap(logicalAgents), [logicalAgents]);
  const logicalAgentImages = useMemo(() => buildLogicalAgentImageMap(logicalAgents), [logicalAgents]);
  const activeLogicalAgent = useMemo(
    () => logicalAgents.find((agent) => agent.id === activeLogicalAgentId && !agent.deletedAt),
    [activeLogicalAgentId, logicalAgents],
  );
  const activeAgentDisplayName = useMemo(
    () => activeLogicalAgent?.displayName ?? displayNameForExecutor(activeAgent, logicalAgents),
    [activeAgent, activeLogicalAgent, logicalAgents],
  );
  // Before and while the thread arrives the panel keeps its docked shape and
  // an empty transcript rather than drawing a guess it would snap out of.
  const { landing, transcriptPending } = threadPanelLayout({
    threadsLoading,
    activeSession,
    hasPendingMessage: Boolean(pendingUserMessage),
    hasOnboardingPanel: Boolean(onboardingPanel),
  });
  // A thread parked on its human: the composer carries the question, and
  // sending the reply is what resumes the work.
  const waiting = useMemo(() => (running ? null : awaitingInput(activeSession, tasks)), [activeSession, running, tasks]);
  // Whatever is sent while the prompt shows — a picked answer or a typed one —
  // answers that question. Naming it lets the backend refuse a reply that a
  // newer question has overtaken instead of resuming the task with it.
  const waitingQuestionId = waiting?.questionId;
  // A stopped run offers ordinary follow-ups beneath its response. Only a
  // question or approval needs a prompt attached to the reply box.
  const followUpWait = waiting?.kind === "check" || waiting?.kind === "budget";
  // A finished turn's suggested follow-ups, while nothing else claims the
  // thread: no run, no question, no decision, no open permission prompt. A
  // stopped run's are the agent's own read of what is left, so they stay.
  const nextSteps = useMemo(
    () => threadNextSteps(activeSession, {
      busy: running || (waiting !== null && !followUpWait) || awaitingDecision
        || openPermissionRequests(activeSession).length > 0,
    }),
    [activeSession, running, waiting, followUpWait, awaitingDecision],
  );
  // What the person writes mid-run waits for the next round; a started
  // thread only — staging a new one has no run to wait on.
  const queueEnabled = Boolean(activeSession) && !initializingThread && !projectReadOnly;
  const threadQueue = useThreadQueue({
    queueKey: threadDraftKey(currentUser, activeSession?.id),
    running,
    awaitsPerson: (waiting !== null && !followUpWait) || awaitingDecision
      || openPermissionRequests(activeSession).length > 0,
    composerRef,
    onCancelRun,
  });
  // A run admitted but not yet taken by a computer: the transcript holds its
  // place in line where the reply will stream.
  const activeQueuedRun = activeSession
    ? queuedRun(activeSession, { nodeOffline: Boolean(activeRuntimeNode && (!activeRuntimeNode.online || activeRuntimeNode.stale)) })
    : null;
  // The task's own next move — accept a result, lift a block — offered in the
  // chip's popover and, while nothing else is asking, docked on the composer.
  const actionTask = lifecycle.task?.current && taskNeedsAction(lifecycle.task.status) ? lifecycle.task : undefined;
  const taskActions = actionTask ? (
    <Button
      type="button"
      size="dense"
      variant={actionTask.status === "review" ? "default" : "outline"}
      disabled={taskStatusActions.busy !== null}
      loading={taskStatusActions.busy !== null}
      onClick={() => void (actionTask.status === "review" ? actionTask.onOpen() : taskStatusActions.unblock())}
    >
      {t(actionTask.status === "review" ? "task_review.title" : "thread.lifecycle.unblock")}
    </Button>
  ) : null;
  const sendAnswering = useCallback<typeof onSend>(
    (style, intent, options) => onSend(
      style,
      intent,
      waitingQuestionId && (intent ?? "accomplish") === "accomplish"
        ? { ...options, questionId: waitingQuestionId }
        : options,
    ),
    [onSend, waitingQuestionId],
  );
  const waitingAgentName = waiting?.run
    ? labelForAgentRun({ agent: waiting.run.agent, agentId: waiting.run.logicalAgentId }, logicalAgentNames, agentDisplayNames)
    : activeAgentDisplayName;
  const bandAgentName = useMemo(
    () => activeSession
      ? threadAgentName(activeSession, activeAgentDisplayName, logicalAgentNames, agentDisplayNames)
      : activeAgentDisplayName,
    [activeSession, activeAgentDisplayName, logicalAgentNames, agentDisplayNames],
  );
  // Every version stays selectable — a transcript chip opens the version its
  // run produced — but the list names each file once, at its newest version.
  const spaceSelectableItems = useMemo(
    () => buildSpaceItems(visibleArtifacts, activeSession?.agentRuns, logicalAgentNames, agentDisplayNames),
    [visibleArtifacts, activeSession?.agentRuns, logicalAgentNames, agentDisplayNames],
  );
  const spaceItems = useMemo(() => {
    const latest = new Set(latestThreadArtifacts(visibleArtifacts));
    return spaceSelectableItems.filter((item) => latest.has(item.artifact));
  }, [spaceSelectableItems, visibleArtifacts]);
  const spaceShowProducer = useMemo(
    () => threadHasMultipleProducers(activeSession?.agentRuns),
    [activeSession?.agentRuns],
  );
  const selectedProject = useMemo(
    () => projects.find((project) => project.id === selectedProjectId) ?? null,
    [projects, selectedProjectId],
  );
  const activeProjectId = activeSession?.projectId ?? null;
  const activeThreadProject = useMemo(
    () => (activeProjectId ? projects.find((project) => project.id === activeProjectId) ?? null : null),
    [projects, activeProjectId],
  );
  const projectOverviewState = resolveProjectOverviewState({
    showProjectOverview,
    project: selectedProject,
    collectionStatus: projectsStatus,
  });

  return (
    <>
      {!taskThread && <ThreadListPanel
        workspaceNavigation={workspaceNavigation}
        directoryMode={directoryMode}
        threads={filteredThreads}
        tasks={tasks}
        projects={projects}
        projectsStatus={projectsStatus}
        projectsError={projectsError}
        onRetryProjects={onRetryProjects}
        query={threadQuery}
        setQuery={setThreadQuery}
        projectFilter={threadProjectFilter}
        projectFilterOptions={threadProjectOptions}
        onProjectFilterChange={onThreadProjectFilterChange}
        /* No thread is on screen while a project overview or a route state
           occupies the pane, so no thread row may claim selection — the
           active session outlives the route that opened it. */
        selectedSessionId={projectOverviewState === "hidden" ? activeSession?.id : undefined}
        selectedProjectId={selectedProjectId}
        listOnScreen={listOnScreen}
        onSelectThread={onSelectThread}
        onSelectProject={onSelectProject}
        onCreateProject={() => setProjectDrawerOpen(true)}
        onNewThread={onNewThread}
        onRenameThread={onRenameThread}
        onCloseThread={onCloseThread}
        width={threadListWidth}
        onResize={onThreadListResize}
        onResizeActive={onThreadListResizeActive}
        paging={threadPaging}
      />}

      {projectOverviewState === "ready" && selectedProject ? (
        <Suspense fallback={<ProjectLoadingState />}>
          <ProjectWorkspacePage
            project={selectedProject}
            agents={logicalAgents}
            tasks={tasks}
            currentUser={currentUser}
            computers={runtimeNodes}
            onOpenThread={onSelectThread}
            onNewThread={() => onNewThread(selectedProject.id)}
            onDeleted={() => onSelectProject(null)}
            onBack={() => onSelectProject(null)}
          />
        </Suspense>
      ) : projectOverviewState === "loading" ? (
        <ProjectLoadingState />
      ) : projectOverviewState === "error" ? (
        <section
          id="project-detail-panel"
          className="chat-panel project-directory-empty project-route-state"
          aria-label={t("project.load_failed")}
          role="alert"
          tabIndex={-1}
        >
          <RelayEmptyState feature="projects"
            fill
            title={t("project.load_failed")}
            body={projectsError || t("project.load_failed_body")}
            actions={(
              <Button type="button" variant="outline" size="dense" onClick={onRetryProjects}>
                {t("workspace.retry")}
              </Button>
            )}
          />
        </section>
      ) : projectOverviewState === "not-found" ? (
        <section
          id="project-detail-panel"
          className="chat-panel project-directory-empty project-route-state"
          aria-label={t("project.not_found")}
          tabIndex={-1}
        >
          <RelayEmptyState feature="projects"
            fill
            title={t("project.not_found")}
            body={t("project.not_found_body")}
            actions={(
              <Button type="button" variant="outline" size="dense" onClick={() => onSelectProject(null)}>
                {t("project.back")}
              </Button>
            )}
          />
        </section>
      ) : showProjectDirectoryEmpty ? (
        <section id="chat-panel" className="chat-panel project-directory-empty" aria-label={t("project.projects")} tabIndex={-1}>
          <RelayEmptyState feature="projects"
            fill
            title={t("project.select_title")}
            body={t("project.select_body")}
          />
        </section>
      ) : (
      <section
        id="chat-panel"
        className={cn("chat-panel", landing && "chat-panel--landing")}
        aria-label={t("nav.threads")}
        tabIndex={-1}
      >
        <ThreadHeader
          taskThread={taskThread}
          activeSession={activeSession}
          /* The thread's coordinates ride the header row as marks — the room,
             the machine, the project, the last movement. They used to claim a
             band row of their own under the header (that row came out of the
             transcript), with the room drawn a second time beside it as a
             bare face stack. */
          facts={activeSession ? (
            <ThreadMeta
              session={activeSession}
              task={lifecycle.task}
              taskStatus={lifecycle.task ? (
                <TaskStatusTimeline
                  task={lifecycle.task}
                  markers={lifecycle.markers}
                  actions={taskActions}
                />
              ) : null}
              agentName={bandAgentName}
              participants={threadParticipants}
              computers={runtimeNodes}
              onOpenProject={onSelectProject}
            />
          ) : null}
          artifactCount={artifactCount}
          spaceOpen={spaceOpen}
          threadListHidden={threadListHidden}
          onToggleSpace={onToggleSpace}
          onToggleThreadList={onToggleThreadList}
          onBackToThreads={onBackToThreads}
        />

        {activeSession ? <ExecutionRecoveryPanel session={activeSession} onRetry={onRetryExecutionRecovery} onReportGone={onReportExecutionGone} /> : null}

        {/* The wizard is instructions, not a chat log: it gets a plain scroller,
            so the transcript's pin-to-bottom (and its live log role) cannot
            scroll it past its own heading as the install command loads in. */}
        {onboardingPanel && !activeSession && !pendingUserMessage ? (
          <div className="transcript">
            <div className="transcript-inner">{onboardingPanel}</div>
          </div>
        ) : (
        /* A log by role, but silent: streamed output re-renders on every
           frame, and a polite log announced each tool line on top of the
           turn's own debounced status. Turn status (Working…, the debounced
           answer) speaks through its own role="status" regions instead. */
        <div className="transcript" ref={transcriptRef} onScroll={onTranscriptScroll} role="log" aria-live="off">
          <div className="transcript-inner">
            {threadLoadError ? (
              <div role="alert">
                <p>{threadLoadError}</p>
                <Button variant="outline" type="button" onClick={onRetryThread}>{t("workspace.retry")}</Button>
              </div>
            ) : transcriptPending ? null : activeSession || pendingUserMessage ? (
              <>
                {transcriptStart > 0 ? (
                  // Keyed by the window start so each page mounts a fresh
                  // sentinel, and the observer reports it again if the new
                  // page still leaves it in range.
                  <div key={`older-${transcriptStart}`} ref={sentinelRef} className="transcript-older-sentinel" aria-hidden="true" />
                ) : null}
                {displayMessages.slice(transcriptStart).map((msg, offset) => {
                  // Grouping and dividers read neighbours, so they index the
                  // full transcript, not the mounted slice.
                  const i = transcriptStart + offset;
                  const phaseLabel = phaseDividerLabel(displayMessages, i, t);
                  const source = handoffSource(displayMessages, i);
                  const isHandoff = source !== undefined;
                  const PhaseIcon = msg.kind === "agent" && isHandoff ? ActionRoute : null;
                  return (
                    <div key={msg.id} className="transcript-turn">
                      {phaseLabel ? (
                        <div className="transcript-phase" role="separator" aria-label={phaseLabel}>
                          <span className="transcript-phase-node" aria-hidden="true" />
                          <span className="transcript-phase-label">
                            {!isHandoff ? (
                              <RelayMark size={ICON.xs} className="transcript-phase-icon transcript-phase-mark" />
                            ) : PhaseIcon ? (
                              <PhaseIcon size={ICON.xs} className="transcript-phase-icon" aria-hidden="true" />
                            ) : null}
                            {phaseLabel}
                          </span>
                        </div>
                      ) : null}
                      <MessageBlock
                        message={msg}
                        automationOpening={msg.id === `${activeSessionId}:goal` ? automationOpening : null}
                        slotLabel={msg.kind === "agent" && runSlots.get(msg.runId) ? `collab_style.turn_${runSlots.get(msg.runId)}` : undefined}
                        styleFallback={msg.kind === "agent" && fallbackRuns.has(msg.runId)}
                        sessionId={activeSession?.id ?? ""}
                        grouped={isGroupedContinuation(displayMessages, i) && !(msg.kind === "agent" && runSlots.get(msg.runId))}
                        agentDisplayNames={agentDisplayNames}
                        logicalAgentNames={logicalAgentNames}
                        logicalAgentImages={logicalAgentImages}
                        onOpenArtifact={onOpenArtifacts}
                        onRetryAgent={onRetryAgent}
                        onResumeAgent={onResumeAgent}
                        retryDisabled={running}
                        pickupFrom={source ? labelForAgentRun(source, logicalAgentNames, agentDisplayNames) : undefined}
                      />
                      {msg.kind === "agent" ? delegations.filter((delegation) => delegation.requesterRunId === msg.runId).map((delegation) => (
                        <DirectDelegationCard key={delegation.id} delegation={delegation} names={logicalAgentNames} />
                      )) : null}
                    </div>
                  );
                })}
                <TeamHandoffCue
                  session={activeSession}
                  logicalAgentNames={logicalAgentNames}
                  logicalAgentImages={logicalAgentImages}
                  agentDisplayNames={agentDisplayNames}
                />
                {activeQueuedRun ? (
                  <QueuedRunCard
                    queued={activeQueuedRun}
                    node={activeRuntimeNode}
                    onCancel={!activeSession?.deletionRequestedAt && !projectReadOnly ? (queueEnabled ? threadQueue.stop : onCancelRun) : undefined}
                  />
                ) : running && !displayMessages.some((message) => message.kind === "agent")
                  ? <RunStartingCue node={activeRuntimeNode} />
                  : null}
                <HandoffStatus session={activeSession} />
                {activeThreadProject && activeSession ? <ProjectManagerProposals projectId={activeThreadProject.id} threadId={activeSession.id} readOnly={Boolean(projectReadOnly)} running={running} /> : null}
                <CollaborationStatus session={activeSession} />
                {/* A setup thread only drafts; the owner applies on the dashboard. */}
                {!projectReadOnly ? (
                  <ProjectSetupCue
                    key={activeSession?.id}
                    project={activeThreadProject}
                    threadId={activeSession?.id}
                    onOpenProject={onSelectProject}
                  />
                ) : null}
                <PermissionPrompts
                  requests={openPermissionRequests(activeSession)}
                  agentLabel={(request) => labelForAgentRun(
                    { agent: request.agent, agentId: request.logicalAgentId },
                    logicalAgentNames,
                    agentDisplayNames,
                  )}
                  onAnswer={onAnswerPermission}
                />
                <NextSteps
                  key={JSON.stringify([activeSession?.id, activeSession?.activeRoundId, waitingQuestionId, followUpWait])}
                  steps={nextSteps}
                  onSend={(text) => composerRef.current?.send(text) ?? Promise.resolve(false)}
                />
                {awaitingDecision ? (
                  <DecisionBar
                    key={`${activeSession?.id}:${activeSession?.activeRoundId}`}
                    logicalAgents={selectableLogicalAgents}
                    sendDecision={sendDecision}
                    sendHandoff={sendHandoff}
                    onRequestChanges={() => composerRef.current?.focus()}
                    deferPrimary={openPermissionRequests(activeSession).length > 0}
                  />
                ) : null}
              </>
            ) : (
              <TranscriptEmpty selectedUser={selectedUser} greetingName={greetingName(currentUser)} />
            )}
          </div>
        </div>
        )}

        <Composer
          key={threadSendKey(currentUser.userId ?? currentUser.username, activeSession?.id, threadDraftId)}
          connectionTargetId={initializingThread ? undefined : activeSession?.id}
          draftKey={threadDraftKey(currentUser, activeSession?.id)}
          ref={composerRef}
          logicalAgents={composerLogicalAgents}
          activeLogicalAgentId={activeLogicalAgentId}
          onLogicalAgentPicked={onLogicalAgentPicked}
          teams={composerTeams}
          activeTeamId={activeTeamId}
          onTeamPicked={onTeamPicked}
          activeAgentDisplayName={activeAgentDisplayName}
          selectedUser={selectedUser}
          initializingThread={initializingThread}
          contextPending={threadsLoading || projectLoading}
          projectName={projectName}
          projectRoom={projectRoom}
          projectRoomSelected={projectRoomSelected}
          onProjectRoomPicked={onProjectRoomPicked}
          readOnly={projectReadOnly}
          runtimeNodes={runtimeNodes}
          runtimeNodeId={runtimeNodeId}
          selectedRuntimeNode={selectedRuntimeNode}
          activeRuntimeNode={activeRuntimeNode}
          mentionCandidates={mentionCandidates}
          onRuntimeNodeChange={onRuntimeNodeChange}
          running={running}
          onSend={sendAnswering}
          onCancelRun={queueEnabled ? threadQueue.stop : onCancelRun}
          onQueue={queueEnabled ? threadQueue.enqueue : undefined}
          queue={queueEnabled ? (
            <MessageQueue
              messages={threadQueue.messages}
              running={running}
              onSteer={threadQueue.steer}
              onEdit={threadQueue.edit}
              onRemove={threadQueue.remove}
            />
          ) : null}
          placeholder={waiting && !followUpWait
            ? t(waiting.kind === "approval" ? "awaiting.placeholder_changes" : "awaiting.placeholder", { agent: waitingAgentName })
            : landing && selectedUser && activeAgentDisplayName
              ? t("composer.placeholder_landing", { agent: activeAgentDisplayName })
              : undefined}
          prompt={followUpWait ? null : waiting ? (
            <AwaitingInputPrompt
              key={`${activeSession?.id}:${waitingQuestionId ?? waiting.kind}`}
              waiting={waiting}
              agentName={waitingAgentName}
              nextAgentName={waiting.nextAgentId ? logicalAgentNames[waiting.nextAgentId] : undefined}
              onChoose={(reply, options) => composerRef.current?.send(reply, options) ?? Promise.resolve(false)}
              onReply={() => composerRef.current?.focus()}
              onMarkDone={() => sendDecision("mark_done")}
            />
          ) : awaitingDecision ? null : actionTask?.status === "review" && !running ? (
            <TaskReviewPanel
              key={actionTask.id}
              taskId={actionTask.id}
              compact
              deferPrimary={awaitingDecision}
              onRequestChanges={() => composerRef.current?.focus()}
            />
          ) : actionTask && !running ? (
            <TaskActionBar
              key={`${activeSession?.id}:${actionTask.id}:${actionTask.status}`}
              task={actionTask}
              busy={taskStatusActions.busy}
              deferPrimary={awaitingDecision}
              onAccept={() => void taskStatusActions.accept()}
              onUnblock={() => void taskStatusActions.unblock()}
              onReply={() => composerRef.current?.focus()}
            />
          ) : null}
        />
      </section>
      )}

      {!showProjectOverview && !showProjectDirectoryEmpty && spaceOpen && activeSession ? (
        <ThreadSpacePanel
          sessionId={activeSession.id}
          projectId={activeSession.projectId ?? null}
          items={spaceItems}
          selectableItems={spaceSelectableItems}
          showProducer={spaceShowProducer}
          selectedArtifactId={spaceArtifactId}
          onSelectArtifact={onSelectSpaceArtifact}
          onClose={onCloseSpace}
          width={spaceWidth}
          onResize={onSpaceResize}
          onResizeActive={onSpaceResizeActive}
        />
      ) : null}
      <ProjectDrawer
        open={projectDrawerOpen}
        computers={runtimeNodes}
        userId={currentUser.userId}
        onClose={() => setProjectDrawerOpen(false)}
        onSaved={(project) => onSelectProject(project.id)}
      />
    </>
  );
}
