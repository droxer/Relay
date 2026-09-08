"use client";

import { useMemo, useState, type Dispatch, RefObject, SetStateAction } from "react";
import { useTranslation } from "react-i18next";
import {
  ActionRoute,
  ICON,
} from "./icons";
import { RelayMark } from "./RelayMark";
import type { AgentName, AgentTeam, DaemonNodeMonitorRecord, EmployeeAgent, ProjectRecord, RelayArtifact, RelaySession } from "../types";
import {
  buildExecutorDisplayNameMap,
  buildLogicalAgentImageMap,
  buildLogicalAgentNameMap,
  displayNameForExecutor,
} from "../lib/agentDisplayNames";
import type { ThreadItem } from "./ThreadRow";
import type { MentionCandidate } from "../lib/mentions";
import { ThreadListPanel } from "./ThreadListPanel";
import { ThreadHeader } from "./ThreadHeader";
import { TranscriptEmpty } from "./TranscriptEmpty";
import { MessageBlock, isGroupedContinuation, type DerivedMessage } from "./MessageBlock";
import { phaseDividerLabel } from "../lib/projectMessages";
import { resolveProjectOverviewState, type ProjectCollectionStatus } from "../lib/projectPage";
import { DecisionBar } from "./composer/DecisionBar";
import { Composer, type ComposerHandle } from "./composer/Composer";
import { ThreadSpacePanel } from "./space/ThreadSpacePanel";
import { buildSpaceItems, threadHasMultipleProducers } from "../lib/threadSpace";
import { ProjectDrawer } from "./ProjectDrawer";
import { ProjectWorkspacePage } from "./ProjectWorkspacePage";
import { RelayEmptyState } from "./RelayEmptyState";
import { Button } from "@/components/ui/button";

export type ThreadsViewProps = {
  directoryMode: "threads" | "projects";
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
  transcriptRef: RefObject<HTMLDivElement | null>;
  composerRef: RefObject<ComposerHandle | null>;
  onTranscriptScroll: () => void;
  onSelectThread: (sessionId: string) => void;
  onSelectProject: (projectId: string | null) => void;
  onNewThread: (projectId?: string | null) => void;
  onRenameThread: (session: RelaySession) => void;
  onCloseThread: (sessionId: string) => void;
  activeAgent: AgentName;
  logicalAgents: EmployeeAgent[];
  selectableLogicalAgents: EmployeeAgent[];
  activeLogicalAgentId: string | null;
  onLogicalAgentPicked: (agent: EmployeeAgent) => void;
  composerTeams: AgentTeam[];
  activeTeamId: string | null;
  onTeamPicked: (team: AgentTeam) => void;
  teamLocked: boolean;
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
  selectedEmployee: string;
  initializingThread: boolean;
  projectName?: string;
  /** The project's roster offered as one composer target. */
  projectRoom?: { memberCount: number } | null;
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
  threadParticipants: EmployeeAgent[];
  onRuntimeNodeChange: (nodeId: string) => void;
  handoffOpen: boolean;
  setHandoffOpen: Dispatch<SetStateAction<boolean>>;
  handoffAgentId: string;
  setHandoffAgentId: Dispatch<SetStateAction<string>>;
  handoffNote: string;
  setHandoffNote: Dispatch<SetStateAction<string>>;
  sendDecision: (kind: "approve" | "reject" | "rerun" | "mark_done") => Promise<void>;
  sendHandoff: () => Promise<void>;
  onSend: () => void;
  onCancelRun: () => void;
  onRetryAgent: (agent: AgentName, agentId?: string) => void;
  running: boolean;
};

export function ThreadsView({
  directoryMode,
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
  activeLogicalAgentId,
  onLogicalAgentPicked,
  composerTeams,
  activeTeamId,
  onTeamPicked,
  teamLocked,
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
  selectedEmployee,
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
  handoffOpen,
  setHandoffOpen,
  handoffAgentId,
  setHandoffAgentId,
  handoffNote,
  setHandoffNote,
  sendDecision,
  sendHandoff,
  onSend,
  onCancelRun,
  onRetryAgent,
  running,
}: ThreadsViewProps) {
  const { t } = useTranslation();
  const [projectDrawerOpen, setProjectDrawerOpen] = useState(false);
  const [editingProject, setEditingProject] = useState<ProjectRecord | null>(null);
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
  const spaceItems = useMemo(
    () => buildSpaceItems(visibleArtifacts, activeSession?.agentRuns, logicalAgentNames, agentDisplayNames),
    [visibleArtifacts, activeSession?.agentRuns, logicalAgentNames, agentDisplayNames],
  );
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
      <ThreadListPanel
        directoryMode={directoryMode}
        threads={filteredThreads}
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
        onCreateProject={() => {
          setEditingProject(null);
          setProjectDrawerOpen(true);
        }}
        onNewThread={onNewThread}
        onRenameThread={onRenameThread}
        onCloseThread={onCloseThread}
        width={threadListWidth}
        onResize={onThreadListResize}
        onResizeActive={onThreadListResizeActive}
      />

      {projectOverviewState === "ready" && selectedProject ? (
        <ProjectWorkspacePage
          project={selectedProject}
          agents={logicalAgents}
          computers={runtimeNodes}
          onOpenThread={onSelectThread}
          onNewThread={() => onNewThread(selectedProject.id)}
          onOpenSettings={() => {
            setEditingProject(selectedProject);
            setProjectDrawerOpen(true);
          }}
          onBack={() => onSelectProject(null)}
        />
      ) : projectOverviewState === "loading" ? (
        <section
          id="project-detail-panel"
          className="chat-panel project-directory-empty project-route-state"
          aria-label={t("project.loading")}
          aria-busy="true"
          role="status"
          tabIndex={-1}
        >
          <RelayEmptyState
            fill
            title={t("project.loading")}
            body={t("project.loading_body")}
          />
        </section>
      ) : projectOverviewState === "error" ? (
        <section
          id="project-detail-panel"
          className="chat-panel project-directory-empty project-route-state"
          aria-label={t("project.load_failed")}
          role="alert"
          tabIndex={-1}
        >
          <RelayEmptyState
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
          <RelayEmptyState
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
          <RelayEmptyState
            fill
            title={t("project.select_title")}
            body={t("project.select_body")}
          />
        </section>
      ) : (
      <section id="chat-panel" className="chat-panel" aria-label={t("nav.threads")} tabIndex={-1}>
        <ThreadHeader
          activeSession={activeSession}
          participants={threadParticipants}
          artifactCount={artifactCount}
          spaceOpen={spaceOpen}
          threadListHidden={threadListHidden}
          onToggleSpace={onToggleSpace}
          onToggleThreadList={onToggleThreadList}
          onBackToThreads={onBackToThreads}
        />

        <div className="transcript" ref={transcriptRef} onScroll={onTranscriptScroll} role="log" aria-live="polite" aria-atomic="false">
          <div className="transcript-inner">
            {activeSession || pendingUserMessage ? (
              <>
                {displayMessages.map((msg, i) => {
                  const phaseLabel = phaseDividerLabel(displayMessages, i, t);
                  const prev = i > 0 ? displayMessages[i - 1] : undefined;
                  const isHandoff =
                    msg.kind === "agent" && prev?.kind === "agent" && prev.agent !== msg.agent;
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
                        sessionId={activeSession?.id ?? ""}
                        grouped={isGroupedContinuation(displayMessages, i)}
                        agentDisplayNames={agentDisplayNames}
                        logicalAgentNames={logicalAgentNames}
                        logicalAgentImages={logicalAgentImages}
                        onOpenArtifact={onOpenArtifacts}
                        onRetryAgent={onRetryAgent}
                        retryDisabled={running}
                      />
                    </div>
                  );
                })}
                {awaitingDecision ? (
                  <DecisionBar
                    logicalAgents={selectableLogicalAgents}
                    sendDecision={sendDecision}
                    handoffOpen={handoffOpen}
                    setHandoffOpen={setHandoffOpen}
                    handoffAgentId={handoffAgentId}
                    setHandoffAgentId={setHandoffAgentId}
                    handoffNote={handoffNote}
                    setHandoffNote={setHandoffNote}
                    sendHandoff={sendHandoff}
                  />
                ) : null}
              </>
            ) : (
              <TranscriptEmpty
                selectedEmployee={selectedEmployee}
                onSuggestion={(text) => {
                  composerRef.current?.setText(text);
                  composerRef.current?.focus();
                }}
              />
            )}
          </div>
        </div>

        <Composer
          ref={composerRef}
          logicalAgents={selectableLogicalAgents}
          activeLogicalAgentId={activeLogicalAgentId}
          onLogicalAgentPicked={onLogicalAgentPicked}
          teams={composerTeams}
          activeTeamId={activeTeamId}
          onTeamPicked={onTeamPicked}
          teamLocked={teamLocked}
          activeAgentDisplayName={activeAgentDisplayName}
          selectedEmployee={selectedEmployee}
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
          onSend={onSend}
          onCancelRun={onCancelRun}
        />
      </section>
      )}

      {!showProjectOverview && !showProjectDirectoryEmpty && spaceOpen && activeSession ? (
        <ThreadSpacePanel
          sessionId={activeSession.id}
          projectId={activeSession.projectId ?? null}
          items={spaceItems}
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
        project={editingProject}
        onClose={() => setProjectDrawerOpen(false)}
        onSaved={(project) => onSelectProject(project.id)}
      />
    </>
  );
}
