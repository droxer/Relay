"use client";

import { lazy, Suspense, useCallback, useEffect, useMemo, useState, type Dispatch, type ReactNode, RefObject, SetStateAction } from "react";
import { useTranslation } from "react-i18next";
import {
  ActionRoute,
  ICON,
} from "./icons";
import { RelayMark } from "./RelayMark";
import type { AgentName, AgentTeam, CurrentUser, DaemonNodeMonitorRecord, UserAgent, ProjectRecord, RelayArtifact, RelaySession, RelayTaskListItem } from "../types";
import type { PermissionAnswers } from "relay-core";
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
import type { ThreadItem } from "./ThreadRow";
import type { MentionCandidate } from "../lib/mentions";
import { ThreadListPanel } from "./ThreadListPanel";
import { ExecutionRecoveryPanel } from "./ExecutionRecoveryPanel";
import { AwaitingInputPrompt } from "./AwaitingInputPrompt";
import { awaitingInput } from "../lib/awaitingInput";
import { ThreadHeader } from "./ThreadHeader";
import { ThreadMeta } from "./ThreadMeta";
import { TranscriptEmpty } from "./TranscriptEmpty";
import { useTaskThreadLifecycle, type OpenTaskRecord } from "../hooks/useTaskThreadLifecycle";
import { useTaskStatusActions } from "../hooks/useTaskStatusActions";
import { TaskStatusTimeline } from "./TaskStatusTimeline";
import { TaskActionBar, taskNeedsAction } from "./TaskActionBar";
import { MessageBlock, isGroupedContinuation, type DerivedMessage } from "./MessageBlock";
import { handoffSource, phaseDividerLabel } from "../lib/projectMessages";
import { parseAutomationOpening } from "../lib/automationOpening";
import { threadOriginIndex } from "../lib/threads";
import { resolveProjectOverviewState, type ProjectCollectionStatus } from "../lib/projectPage";
import { HandoffStatus } from "./HandoffStatus";
import { TeamHandoffCue } from "./TeamHandoffCue";
import { styleForRun, turnSlot } from "../lib/collaborationStyle";
import { CollaborationStatus } from "./CollaborationStatus";
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
  taskThread?: boolean;
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
  onAnswerPermission: (requestId: string, decision: "allow" | "deny", note?: string, answers?: PermissionAnswers) => Promise<void>;
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
  taskThread = false,
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
  // An automation run's first turn draws as the automation's card. A fired
  // run says so in its goal's trigger block; a scheduled one carries none, so
  // the task list is what marks the thread as a routine occurrence.
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
  // the first turn rarely shows its plain-text fallback.
  const hasTranscript = Boolean(activeSession);
  useEffect(() => {
    if (hasTranscript) preloadMarkdown();
  }, [hasTranscript]);
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
  // A thread parked on its human: the composer carries the question, and
  // sending the reply is what resumes the work.
  const waiting = useMemo(() => (running ? null : awaitingInput(activeSession, tasks)), [activeSession, running, tasks]);
  // Whatever is sent while the prompt shows — a picked answer or a typed one —
  // answers that question. Naming it lets the backend refuse a reply that a
  // newer question has overtaken instead of resuming the task with it.
  const waitingQuestionId = waiting?.questionId;
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
      onClick={() => void (actionTask.status === "review" ? taskStatusActions.accept() : taskStatusActions.unblock())}
    >
      {t(actionTask.status === "review" ? "thread.lifecycle.accept" : "thread.lifecycle.unblock")}
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
  const projectOverviewState = resolveProjectOverviewState({
    showProjectOverview,
    project: selectedProject,
    collectionStatus: projectsStatus,
  });

  return (
    <>
      {!taskThread && <ThreadListPanel
        directoryMode={directoryMode}
        threads={filteredThreads}
        tasks={tasks}
        projects={projects}
        projectsStatus={projectsStatus}
        projectsError={projectsError}
        onRetryProjects={onRetryProjects}
        computers={runtimeNodes}
        query={threadQuery}
        setQuery={setThreadQuery}
        /* No thread is on screen while a project overview or a route state
           occupies the pane, so no thread row may claim selection — the
           active session outlives the route that opened it. */
        selectedSessionId={projectOverviewState === "hidden" ? activeSession?.id : undefined}
        selectedProjectId={selectedProjectId}
        onSelectThread={onSelectThread}
        onSelectProject={onSelectProject}
        onCreateProject={() => setProjectDrawerOpen(true)}
        onNewThread={onNewThread}
        onRenameThread={onRenameThread}
        onCloseThread={onCloseThread}
        width={threadListWidth}
        onResize={onThreadListResize}
        onResizeActive={onThreadListResizeActive}
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
      <section id="chat-panel" className="chat-panel" aria-label={t("nav.threads")} tabIndex={-1}>
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
        <div className="transcript" ref={transcriptRef} onScroll={onTranscriptScroll} role="log" aria-live="polite" aria-atomic="false">
          <div className="transcript-inner">
            {activeSession || pendingUserMessage ? (
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
                    </div>
                  );
                })}
                <TeamHandoffCue
                  session={activeSession}
                  logicalAgentNames={logicalAgentNames}
                  logicalAgentImages={logicalAgentImages}
                  agentDisplayNames={agentDisplayNames}
                />
                <HandoffStatus session={activeSession} />
                <CollaborationStatus session={activeSession} />
                <PermissionPrompts
                  requests={openPermissionRequests(activeSession)}
                  agentLabel={(request) => labelForAgentRun(
                    { agent: request.agent, agentId: request.logicalAgentId },
                    logicalAgentNames,
                    agentDisplayNames,
                  )}
                  onAnswer={onAnswerPermission}
                />
                {awaitingDecision ? (
                  <DecisionBar
                    logicalAgents={selectableLogicalAgents}
                    sendDecision={sendDecision}
                    sendHandoff={sendHandoff}
                    deferPrimary={openPermissionRequests(activeSession).length > 0}
                  />
                ) : null}
              </>
            ) : (
              <TranscriptEmpty
                selectedUser={selectedUser}
                onSuggestion={(text) => {
                  composerRef.current?.setText(text);
                  composerRef.current?.focus();
                }}
              />
            )}
          </div>
        </div>
        )}

        <Composer
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
          onCancelRun={onCancelRun}
          placeholder={waiting ? t("awaiting.placeholder", { agent: waitingAgentName }) : undefined}
          prompt={waiting ? (
            <AwaitingInputPrompt
              key={activeSession?.id}
              waiting={waiting}
              agentName={waitingAgentName}
              agentImage={waiting.run?.logicalAgentId ? logicalAgentImages[waiting.run.logicalAgentId] : undefined}
              onChoose={(reply, options) => composerRef.current?.send(reply, options) ?? Promise.resolve(false)}
              onReply={() => composerRef.current?.focus()}
              onMarkDone={() => sendDecision("mark_done")}
            />
          ) : actionTask && !running ? (
            <TaskActionBar
              task={actionTask}
              busy={taskStatusActions.busy}
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
