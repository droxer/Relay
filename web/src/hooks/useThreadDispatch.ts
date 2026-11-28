import { type MutableRefObject } from "react";
import type { TFunction } from "i18next";
import type { AgentName, AgentTeam, UserAgent, ProjectListItem, RelaySession } from "../types";
import type { AppRoute } from "../lib/viewTypes";
import type { ComposerHandle } from "../components/composer/Composer";
import type { useRelayMutations } from "./useRelayMutations";
import type { useTranscriptPin } from "./useTranscriptPin";
import type { useThreadTargets } from "./useThreadTargets";
import { chooseSendAction, sendThreadSessionId, suppressActiveSessionDuringPendingSend } from "../lib/sendAction";
import { canCancelThreadRun, threadCancelNodeId } from "../lib/threadRunning";
import { resolveThreadMessageAddress, threadMessageInput, threadMessageOperationKey, threadRoundTeam } from "../lib/messageRouting";
import { formatDispatchError } from "../lib/agentReadiness";
import { defaultWorkflowId } from "../lib/workflowSelection";
import { rerunAssignmentForSession } from "../lib/workflow";
import { isUserAgentRoutable, preferredRoutableAgent } from "../lib/agentDisplayNames";
import { useHandoffStore } from "../lib/handoffStore";
import { useComposerTargetStore } from "../lib/composerTargetStore";
import { useRelayStore } from "../lib/store";
import { projectRoomAgentIds } from "../lib/taskAssignment";
import { retainThreadDispatchView } from "../lib/threadDispatchView";
import { threadSendKey, useThreadSendStore } from "../lib/threadSendStore";
import { restoreComposerDraft, threadDraftKey } from "./useComposer";
import { usePendingThreadMessage, type PendingDirectMessage, type ThreadMessageRetry } from "./usePendingThreadMessage";
import { sessionComputer } from "../lib/workspaceScope";

type Mutations = ReturnType<typeof useRelayMutations>;
type Transcript = ReturnType<typeof useTranscriptPin>;
type ThreadTargets = ReturnType<typeof useThreadTargets>;

/**
 * Everything that turns an intent in the thread UI into a backend run: the
 * composer send, the cancel, and the three recovery dispatches (rerun, retry,
 * handoff).
 *
 * These lived inline in App.tsx, where their dependencies were implicit
 * closure captures — you could not tell what `sendMessage` touched without
 * reading all 130 lines of it. Pulling them out makes the dependency list
 * explicit. Thread-scoped operations retain pending-send cancellation across
 * renders until dispatch returns the accepted thread ID.
 *
 * The types below are DERIVED from the hooks and mutations they come from
 * (`ReturnType<typeof …>`) rather than restated. A restated shape is a second
 * definition that drifts; this one cannot.
 */
export interface ThreadDispatchDeps {
  /* --- the thread being acted on --------------------------------------- */
  activeSession: RelaySession | undefined;
  activeProject: ProjectListItem | null;
  projectLeadDiscussion?: boolean;
  activeRun: Parameters<typeof canCancelThreadRun>[0]["activeRun"];
  activeRunOwner: { node?: Parameters<typeof threadCancelNodeId>[0]["node"] } | null | undefined;
  activeRuntimeNode: Parameters<typeof threadCancelNodeId>[0]["node"] | null;
  threadRunning: boolean;
  requiresRuntimeSelection: boolean;
  projectDispatchDisabled: boolean;

  /* --- who can be addressed (the pick itself is in useComposerTargetStore) */
  effectiveSelectableLogicalAgents: UserAgent[];
  composerLogicalAgents?: UserAgent[];
  threadMentionCandidates: Parameters<typeof resolveThreadMessageAddress>[0]["candidates"];
  composerTeams: AgentTeam[];

  /* --- where it runs ---------------------------------------------------- */
  selectedUser: string;
  draftComputerId?: string | null;
  draftProjectId: string | null;
  requestedThreadId?: string | null;
  fallbackNode: Parameters<typeof threadCancelNodeId>[0]["fallbackNode"];
  selectedThreadNodeId: ThreadTargets["selectedThreadNodeId"];
  runtimeNodes?: Parameters<typeof sessionComputer>[1];
  selectedToken: string | undefined;
  tokens: Record<string, string | undefined>;

  /* --- the composer + transcript surfaces ------------------------------- */
  composerRef: MutableRefObject<ComposerHandle | null>;
  transcript: Transcript;

  /* --- idempotency bookkeeping ------------------------------------------ */
  messageOperationIdsRef: MutableRefObject<Map<string, string>>;
  recoveryOperationIdsRef: MutableRefObject<Map<string, string>>;

  /* --- mutations -------------------------------------------------------- */
  submitThreadMessageMutation: Mutations["submitThreadMessageMutation"];
  runLogicalAgentsMutation: Mutations["runLogicalAgentsMutation"];
  requestThreadRecoveryMutation: Mutations["requestThreadRecoveryMutation"];
  recordDecisionMutation: Mutations["recordDecisionMutation"];
  cancelRunMutation: Mutations["cancelRunMutation"];

  /* --- navigation (thread selection, composer target and send state are
         written straight to their stores) ------------------------------- */
  syncThreadUrl: (sessionId: string | null, replace?: boolean, projectId?: string | null, taskId?: string | null, computerId?: string | null) => void;
  navigateToRoute: (route: AppRoute) => void;

  /* --- reporting -------------------------------------------------------- */
  reportMutationError: (label: string, error: unknown, message: string) => void;
  t: TFunction;
}

export function useThreadDispatch(deps: ThreadDispatchDeps) {
  const {
    activeSession, activeProject, activeRun, activeRunOwner, activeRuntimeNode,
    projectLeadDiscussion,
    threadRunning, requiresRuntimeSelection, projectDispatchDisabled,
    effectiveSelectableLogicalAgents,
    composerLogicalAgents = effectiveSelectableLogicalAgents,
    threadMentionCandidates, composerTeams,
    selectedUser, draftComputerId, draftProjectId, requestedThreadId, fallbackNode, selectedThreadNodeId, runtimeNodes = [], selectedToken, tokens,
    composerRef, transcript,
    messageOperationIdsRef, recoveryOperationIdsRef,
    submitThreadMessageMutation, runLogicalAgentsMutation, requestThreadRecoveryMutation,
    recordDecisionMutation, cancelRunMutation,
    syncThreadUrl, navigateToRoute,
    reportMutationError, t,
  } = deps;

  const composingNew = useRelayStore((state) => state.composingNew);
  const activeThreadId = composingNew || activeSession?.archived ? undefined : activeSession?.id;
  const pending = usePendingThreadMessage(JSON.stringify([
    selectedUser,
    activeThreadId ? ["thread", activeThreadId] : ["draft", draftProjectId, draftComputerId ?? null],
  ]), "direct");
  const saved = pending.message;
  const pendingSendKey = threadSendKey(selectedUser, activeThreadId, useRelayStore((state) => state.threadDraftId));
  const pendingBusy = useThreadSendStore((state) => !!state.operations[pendingSendKey]?.dispatching);
  const draftProjectLocked = pendingBusy || saved?.kind === "create";

  const threadComputerId = (session: Pick<RelaySession, "projectId" | "computerId" | "daemonNodeId">) =>
    session.projectId ? null : sessionComputer(session, runtimeNodes);

  async function sendMessage(
    requestedStyle?: import("../types").CollaborationStyle,
    intent: import("../types").ThreadMessageInput["intent"] = "accomplish",
    { literal = false, questionId, approve = false, attachmentIds = [], userMessageId: queuedMessageId }: import("../components/composer/Composer").ComposerDispatchOptions = {},
  ) {
    const raw = composerRef.current?.getText().trim() ?? "";
    if ((!raw && !attachmentIds.length) || !selectedUser || threadRunning || projectDispatchDisabled || pending.read()) return false;
    if (requiresRuntimeSelection && !selectedThreadNodeId) {
      reportMutationError("Computer required", null, t("errors.thread_computer_required"));
      return false;
    }
    // Read at send time: who the composer addresses and whether a new thread
    // is being staged live in their stores, not in this hook's props.
    const { activeAgent: chosenExecutor, activeLogicalAgentId: chosenAgentId, pendingThreadTeamId, projectRoomTarget } =
      useComposerTargetStore.getState();
    const activeTarget = preferredRoutableAgent(composerLogicalAgents, chosenAgentId);
    const activeLogicalAgentId = activeTarget?.id ?? null;
    const activeAgent = activeTarget?.executorKind ?? chosenExecutor;
    const { composingNew, threadDraftId } = useRelayStore.getState();
    // When staging a new thread, always create; otherwise continue the
    // open one. composingNew forces a fresh owner-scoped session here.
    const action = composingNew ? { kind: "create" as const } : chooseSendAction({ activeSessionId: activeSession?.id ?? null, session: activeSession });
    const sessionId = action.kind === "append" ? action.sessionId : undefined;
    const sendKey = threadSendKey(selectedUser, sessionId, threadDraftId);
    if (sessionId !== activeThreadId || useThreadSendStore.getState().operations[sendKey]?.dispatching) return false;
    // A team picked while staging a new thread turns the message into a team
    // thread: no single-agent routing, the backend expands the roster.
    const pendingTeam = action.kind === "create" && pendingThreadTeamId
      ? composerTeams.find((team) => team.id === pendingThreadTeamId)
      : undefined;
    // A started thread may hand this round to a team on its computer, or — in
    // a team thread — to one agent. Only a team other than the thread's own is
    // named on the wire; the thread's own team is the room.
    const roundTeam = action.kind === "append" && !activeProject
      ? threadRoundTeam({
          threadTeamId: activeSession?.teamId,
          pickedTeamId: pendingThreadTeamId,
          roomTarget: projectRoomTarget,
        })
      : { teamId: null, addressTeamId: null };
    const addressedTeamId = roundTeam.addressTeamId
      && composerTeams.some((team) => team.id === roundTeam.addressTeamId)
      ? roundTeam.addressTeamId
      : null;
    const goal = raw || "Describe the attached images.";
    let newThreadAgentIds: string[] | undefined;
    // The backend resolves the Lead role or the room when no Agent is named.
    const projectDefaultRecipient = projectRoomTarget && (
      (sessionId && projectLeadDiscussion)
      || (activeProject && projectRoomAgentIds(activeProject, activeSession).length > 0)
    );
    // A mention overrides the footer selection. Team messages intentionally
    // default to the room; every single-agent message requires one valid
    // footer selection and never fails open to the room.
    const messageAddress = resolveThreadMessageAddress({
      text: raw,
      literal,
      candidates: threadMentionCandidates,
      defaultAgentId: projectDefaultRecipient || pendingTeam || roundTeam.teamId
        ? undefined
        : activeLogicalAgentId,
    });
    if (messageAddress.blocked) {
      reportMutationError(
        messageAddress.reason === "mention" ? "Mention unresolved" : "Agent not ready for dispatch",
        null,
        messageAddress.reason === "mention"
          ? t("composer.mention_blocked")
          : t("errors.agent_not_ready", { agent: activeAgent }),
      );
      return false;
    }
    // Participant availability is a creation concern. Continued threads send
    // semantic intent to the conductor, which resolves the room against live
    // membership and placement state on the server.
    if (!sessionId && !pendingTeam) {
      newThreadAgentIds = messageAddress.addressAgentIds;
    }
    // Echo the turn immediately. For a continued session we mint the message id
    // here and hand it to the backend so the persisted event reconciles by id.
    const messageOperationKey = threadMessageOperationKey({
      sessionId: sessionId ?? JSON.stringify([sendKey, pendingTeam?.id, requestedStyle, activeProject?.id, selectedThreadNodeId]),
      attachmentIds,
      text: goal,
      intent,
      addressAgentIds: messageAddress.addressAgentIds,
      addressTeamId: addressedTeamId,
      style: roundTeam.teamId ? requestedStyle : undefined,
      questionId,
      approve,
    });
    const retainedMessageId = messageOperationIdsRef.current.get(messageOperationKey);
    const userMessageId = queuedMessageId ?? retainedMessageId ?? `evt_${crypto.randomUUID()}`;
    const message: PendingDirectMessage = sessionId
      ? { kind: "append", id: userMessageId, text: raw, sessionId, input: { ...threadMessageInput({
          text: goal,
          intent,
          addressAgentIds: messageAddress.addressAgentIds,
          addressTeamId: addressedTeamId,
          userMessageId,
          workflowId: roundTeam.teamId && requestedStyle ? `preset:${requestedStyle}` : undefined,
          questionId,
          approve,
        }), attachmentIds } }
      : { kind: "create", id: userMessageId, text: raw, input: {
          taskGoal: goal,
          attachmentIds,
          userMessageId,
          idempotencyKey: userMessageId,
          ...(activeProject ? { projectId: activeProject.id } : {}),
          ...(!activeProject && selectedThreadNodeId ? { daemonNodeId: selectedThreadNodeId } : {}),
          ...(activeProject
            ? newThreadAgentIds!.length
              ? { assignments: newThreadAgentIds!.map((agentId) => ({ agentId })) }
              : {}
            : pendingTeam
            ? { teamId: pendingTeam.id, workflowId: requestedStyle ? `preset:${requestedStyle}` : defaultWorkflowId(pendingTeam) }
            : { assignments: newThreadAgentIds!.map((agentId) => ({ agentId })) }),
        } };
    return dispatchMessage(message, messageOperationKey, activeTarget);
  }

  async function dispatchMessage(message: PendingDirectMessage, operationKey?: string, initialTarget?: UserAgent | null) {
    if (useRelayStore.getState().selectedUser !== selectedUser) return false;
    const isInitial = !!operationKey;
    const sessionId = message.kind === "append" ? message.sessionId : undefined;
    const goal = message.kind === "append" ? message.input.text : message.input.taskGoal;
    const action = message.kind === "append" ? message : { kind: "create" as const };
    const creatingSession = suppressActiveSessionDuringPendingSend(action);
    // Establish the draft before routing so the URL and transcript agree.
    useRelayStore.getState().setComposingNew(creatingSession);
    let sendKey = threadSendKey(selectedUser, sessionId, useRelayStore.getState().threadDraftId);
    if (useThreadSendStore.getState().operations[sendKey]?.dispatching) return false;
    if (creatingSession && draftComputerId) syncThreadUrl(null, true, activeProject?.id, undefined, draftComputerId);
    else syncThreadUrl(sendThreadSessionId(action), true, activeProject?.id, undefined,
      action.kind === "append" && activeSession ? threadComputerId(activeSession) : undefined);
    const dispatchId = useThreadSendStore.getState().beginSend(sendKey, { id: message.id, text: goal }, creatingSession);
    pending.save(message, isInitial);
    const view = retainThreadDispatchView();
    if (operationKey) {
      messageOperationIdsRef.current.delete(operationKey);
      composerRef.current?.clear();
    }
    transcript.pinToBottom();
    try {
      const done = message.kind === "append"
        ? await submitThreadMessageMutation.mutateAsync({ sessionId: message.sessionId, input: message.input })
        : await runLogicalAgentsMutation.mutateAsync(message.input);
      if (!done?.id || (sessionId && done.id !== sessionId)) {
        throw new Error("Missing Thread message acknowledgement");
      }
      pending.clear(message.id);
      // A staged team became the new thread's own team; a team picked in a
      // started thread stays the target for its next round too.
      if (view.isCurrent()) {
        if (!sessionId) useComposerTargetStore.getState().clearPendingTeam();
        if (activeSession?.id !== done.id) useComposerTargetStore.getState().pickRoom();
      }
      // A new single-agent thread starts on the agent it was created with, so
      // coming back to it later still names that agent.
      if (message.kind === "create" && !message.input.teamId && !message.input.projectId) {
        const target = initialTarget ?? composerLogicalAgents.find((agent) => agent.id === message.input.assignments?.[0]?.agentId);
        if (target) useComposerTargetStore.getState().rememberThreadPick(done.id, { kind: "agent", agent: { id: target.id, executorKind: target.executorKind } });
      }
      const stopRequested = useThreadSendStore.getState().operations[sendKey]?.stopRequested;
      const acceptedKey = threadSendKey(selectedUser, done.id);
      useThreadSendStore.getState().acceptThread(sendKey, dispatchId, acceptedKey);
      sendKey = acceptedKey;
      if (view.isCurrent()) {
        view.release();
        useRelayStore.getState().openSession(done.id);
        syncThreadUrl(done.id, true, done.projectId ?? activeProject?.id, undefined, threadComputerId(done));
      }
      if (stopRequested && done.messageRunRequestId) {
        // The receipt can arrive after this run has already finished.
        await cancelSessionRun(done.id, done.projectId, done.messageRunRequestId);
      }
      return true;
    } catch (error) {
      useThreadSendStore.getState().dropPendingMessage(sendKey, dispatchId);
      // A definite rejection leaves the text editable. With an ambiguous
      // outcome, retain the entire request for a same-ID retry.
      if (pending.reject(message, error, isInitial)) {
        if (operationKey) messageOperationIdsRef.current.set(operationKey, message.id);
        if (view.isCurrent() && !composerRef.current?.getText().trim()) composerRef.current?.setText(message.text);
        else restoreComposerDraft(threadDraftKey({ username: selectedUser }, sessionId), message.text);
      }
      reportMutationError(
        "Failed to send message",
        error,
        formatDispatchError(error, t) ?? t("errors.send_message"),
      );
      return false;
    } finally {
      if (isInitial) pending.finishInitial(message.id);
      view.release();
      useThreadSendStore.getState().endDispatch(sendKey, dispatchId);
    }
  }

  const messageRetry: ThreadMessageRetry | null = saved && saved.kind !== "enqueue"
    && !(pendingBusy && pending.initial)
    && selectedUser && (!projectDispatchDisabled || saved.kind === "create")
    && (!requestedThreadId || requestedThreadId === activeSession?.id)
    ? {
      text: saved.kind === "append" ? saved.input.text : saved.input.taskGoal,
      busy: pendingBusy,
      attachmentIds: saved.input.attachmentIds,
      retry: async () => {
        if (projectDispatchDisabled || pending.read()?.id !== saved.id) return false;
        if (saved.kind === "append" && saved.sessionId !== activeThreadId) return false;
        return dispatchMessage(saved);
      },
      dismiss: () => {
        if (pending.read()?.id !== saved.id || pendingBusy) return;
        pending.clear(saved.id);
        if (!composerRef.current?.getText().trim()) composerRef.current?.setText(saved.text);
      },
    }
    : null;

  async function cancelActiveRun() {
    const key = threadSendKey(selectedUser, activeSession?.id, useRelayStore.getState().threadDraftId);
    if (useThreadSendStore.getState().operations[key]?.dispatching) {
      useThreadSendStore.getState().requestStop(key);
      return;
    }
    if (!activeSession) return;
    if (!canCancelThreadRun({ activeRun, session: activeSession })) return;
    await cancelSessionRun(activeRun?.sessionId ?? activeSession.id, activeSession.projectId);
  }

  async function cancelSessionRun(sessionId: string, projectId?: string | null, expectedRunRequestId?: string) {
    const view = retainThreadDispatchView();
    const selected = useRelayStore.getState();
    const onThread = !selected.composingNew && (selected.selectedSessionId ?? selected.activeSessionId) === sessionId;
    const cancelNodeId = threadCancelNodeId({
      node: activeRunOwner?.node ?? activeRuntimeNode ?? undefined,
      fallbackNode,
    });
    try {
      const session = await cancelRunMutation.mutateAsync({
        sessionId,
        token: (cancelNodeId ? tokens[cancelNodeId] : undefined) ?? selectedToken,
        reason: t("cancel.reason"),
        ...(expectedRunRequestId ? { expectedRunRequestId } : {}),
      });
      if (onThread && view.isCurrent()) {
        useRelayStore.getState().setSelectedSessionId(session.id);
        syncThreadUrl(session.id, true, session.projectId ?? projectId, undefined, threadComputerId(session));
      }
    } catch {
      // mutation onError surfaces a toast.
    } finally {
      view.release();
    }
  }

  function recoveryOperationId(key: string): string {
    const existing = recoveryOperationIdsRef.current.get(key);
    if (existing) return existing;
    const created = crypto.randomUUID();
    recoveryOperationIdsRef.current.set(key, created);
    return created;
  }

  /**
   * The one path that hands a thread back to an agent.
   *
   * Rerun (from the decision bar), retry (from a turn's action row), and
   * handoff were three near-identical copies of this: resolve a routable
   * agent, make it active, dispatch a recovery run under an idempotency key,
   * then follow the returned session. Keeping them apart meant the two rerun
   * copies had to agree on the `${sessionId}:rerun:${agentId}` key format by
   * hand — and if they ever drifted, a retried turn would mint a second
   * operation id for work the backend had already accepted.
   *
   * `prefer` is the turn's own logical agent; `fallback` is its executor kind,
   * used only for legacy runs that recorded no agent id. Handoff passes no
   * fallback on purpose — the target there is an explicit choice from the
   * picker, so resolving it to "some other agent of the same kind" would send
   * the thread somewhere the author did not pick.
   */
  async function dispatchRecovery({
    prefer,
    fallback,
    kind,
    note,
    resume = false,
    failureLabel,
    failureMessageKey,
  }: {
    prefer?: string;
    fallback?: AgentName;
    kind: "rerun" | "handoff";
    note?: string;
    /** Rerun inside the agent's own runtime conversation instead of afresh. */
    resume?: boolean;
    failureLabel: string;
    failureMessageKey: string;
  }) {
    if (!activeSession || !selectedUser || threadRunning || projectDispatchDisabled) return false;
    const logicalAgent = effectiveSelectableLogicalAgents.find(
      (candidate) => candidate.id === prefer && isUserAgentRoutable(candidate),
    ) ?? (!prefer && fallback
      ? effectiveSelectableLogicalAgents.find(
          (candidate) => candidate.executorKind === fallback && isUserAgentRoutable(candidate),
        )
      : undefined);
    if (!logicalAgent) {
      reportMutationError(
        `Agent not ready for ${kind}`,
        null,
        t("errors.agent_not_ready", { agent: prefer ?? fallback }),
      );
      return false;
    }
    const sendKey = threadSendKey(selectedUser, activeSession.id);
    if (useThreadSendStore.getState().operations[sendKey]?.dispatching) return false;
    const dispatchId = useThreadSendStore.getState().beginDispatch(sendKey);
    let view: ReturnType<typeof retainThreadDispatchView> | undefined;
    try {
      useComposerTargetStore.getState().setActiveTarget(logicalAgent);
      // Keep the current Project or Computer when this Thread is already open.
      if (kind === "rerun") {
        if (requestedThreadId !== activeSession.id) {
          useRelayStore.getState().setSelectedSessionId(activeSession.id);
          navigateToRoute("main");
        }
        transcript.pinToBottom();
      }
      view = retainThreadDispatchView();
      const recoveryKey = [activeSession.id, resume ? "resume" : kind, logicalAgent.id, ...(note ? [note] : [])].join(":");
      const done = await requestThreadRecoveryMutation.mutateAsync({
        sessionId: activeSession.id,
        input: {
          kind,
          idempotencyKey: recoveryOperationId(recoveryKey),
          targetAgentId: logicalAgent.id,
          ...(note ? { note } : {}),
          ...(resume ? { resume: true } : {}),
        },
      });
      recoveryOperationIdsRef.current.delete(recoveryKey);
      if (view.isCurrent()) {
        useRelayStore.getState().setSelectedSessionId(done.id);
        if (kind === "handoff") useHandoffStore.getState().finishSend();
        syncThreadUrl(done.id, true, done.projectId ?? activeSession.projectId, undefined, threadComputerId(done));
      }
      if (useThreadSendStore.getState().operations[sendKey]?.stopRequested) await cancelSessionRun(done.id, done.projectId);
      return true;
    } catch (error) {
      reportMutationError(
        failureLabel,
        error,
        formatDispatchError(error, t) ?? t(failureMessageKey),
      );
      return false;
    } finally {
      view?.release();
      useThreadSendStore.getState().endDispatch(sendKey, dispatchId);
    }
  }

  /** Resolves whether the decision was recorded; a failure is already toasted. */
  async function sendDecision(kind: "approve" | "reject" | "rerun" | "mark_done"): Promise<boolean> {
    if (!activeSession) return false;
    if (kind === "rerun") {
      const assignment = rerunAssignmentForSession(activeSession, useComposerTargetStore.getState().activeAgent);
      return dispatchRecovery({
        prefer: assignment.agentId,
        fallback: assignment.agent,
        kind: "rerun",
        failureLabel: "Failed to rerun assignment",
        failureMessageKey: "errors.rerun_assignment",
      });
    }
    const view = retainThreadDispatchView();
    try {
      const session = await recordDecisionMutation.mutateAsync({
        sessionId: activeSession.id,
        kind,
        token: selectedToken,
      });
      if (view.isCurrent()) {
        useRelayStore.getState().setSelectedSessionId(session.id);
        syncThreadUrl(session.id, true, session.projectId ?? activeSession.projectId, undefined, threadComputerId(session));
      }
      return true;
    } catch {
      // mutation onError surfaces a toast.
      return false;
    } finally {
      view.release();
    }
  }

  async function retryAgentMessage(agent: AgentName, agentId?: string) {
    await dispatchRecovery({
      prefer: agentId,
      fallback: agent,
      kind: "rerun",
      failureLabel: "Failed to retry agent response",
      failureMessageKey: "errors.rerun_assignment",
    });
  }

  async function resumeAgentMessage(agent: AgentName, agentId?: string) {
    await dispatchRecovery({
      prefer: agentId,
      fallback: agent,
      kind: "rerun",
      resume: true,
      failureLabel: "Failed to resume agent run",
      failureMessageKey: "errors.rerun_assignment",
    });
  }

  async function sendHandoff() {
    // Read at send time: the draft lives in the handoff store, not in props.
    const { agentId, note } = useHandoffStore.getState();
    await dispatchRecovery({
      prefer: agentId,
      kind: "handoff",
      note: note.trim() || undefined,
      failureLabel: "Failed to send handoff",
      failureMessageKey: "errors.send_handoff",
    });
  }


  return { sendMessage, messageRetry, draftProjectLocked, cancelActiveRun, sendDecision, retryAgentMessage, resumeAgentMessage, sendHandoff };
}
