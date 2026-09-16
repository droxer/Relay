import { useRef, type MutableRefObject } from "react";
import type { TFunction } from "i18next";
import type { AgentName, AgentTeam, EmployeeAgent, ProjectRecord, RelaySession } from "../types";
import type { AppRoute } from "../lib/viewTypes";
import type { ComposerHandle } from "../components/composer/Composer";
import type { useRelayMutations } from "./useRelayMutations";
import type { useTranscriptPin } from "./useTranscriptPin";
import type { useThreadTargets } from "./useThreadTargets";
import { chooseSendAction, sendThreadSessionId, suppressActiveSessionDuringPendingSend } from "../lib/sendAction";
import { canCancelThreadRun, threadCancelNodeId } from "../lib/threadRunning";
import { resolveThreadMessageAddress, threadMessageInput, threadMessageOperationKey } from "../lib/messageRouting";
import { formatDispatchError } from "../lib/agentReadiness";
import { rerunAssignmentForSession } from "../lib/workflow";
import { isEmployeeAgentRoutable } from "../lib/agentDisplayNames";

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
 * explicit. A ref retains pending-send cancellation across renders until
 * dispatch returns the accepted thread ID.
 *
 * The types below are DERIVED from the hooks and mutations they come from
 * (`ReturnType<typeof …>`) rather than restated. A restated shape is a second
 * definition that drifts; this one cannot.
 */
export interface ThreadDispatchDeps {
  /* --- the thread being acted on --------------------------------------- */
  activeSession: RelaySession | undefined;
  activeProject: ProjectRecord | null;
  activeRun: Parameters<typeof canCancelThreadRun>[0]["activeRun"];
  activeRunOwner: { node?: Parameters<typeof threadCancelNodeId>[0]["node"] } | null | undefined;
  activeRuntimeNode: Parameters<typeof threadCancelNodeId>[0]["node"] | null;
  threadRunning: boolean;
  requiresRuntimeSelection: boolean;
  projectDispatchDisabled: boolean;
  projectRoomTarget: boolean;

  /* --- who is being addressed ------------------------------------------ */
  activeAgent: AgentName;
  activeLogicalAgentId: string | null;
  effectiveSelectableLogicalAgents: EmployeeAgent[];
  threadMentionCandidates: Parameters<typeof resolveThreadMessageAddress>[0]["candidates"];
  composerTeams: AgentTeam[];
  pendingThreadTeamId: string | null;
  handoffAgentId: string;
  handoffNote: string;

  /* --- where it runs ---------------------------------------------------- */
  selectedEmployee: string;
  selectedSandbox: Parameters<typeof threadCancelNodeId>[0]["sandbox"];
  selectedThreadNodeId: ThreadTargets["selectedThreadNodeId"];
  selectedToken: string | undefined;
  tokens: Record<string, string | undefined>;

  /* --- the composer + transcript surfaces ------------------------------- */
  composerRef: MutableRefObject<ComposerHandle | null>;
  transcript: Transcript;
  composingNew: boolean;

  /* --- idempotency bookkeeping ------------------------------------------ */
  messageOperationIdsRef: MutableRefObject<Map<string, string>>;
  recoveryOperationIdsRef: MutableRefObject<Map<string, string>>;

  /* --- mutations -------------------------------------------------------- */
  submitThreadMessageMutation: Mutations["submitThreadMessageMutation"];
  runLogicalAgentsMutation: Mutations["runLogicalAgentsMutation"];
  requestThreadRecoveryMutation: Mutations["requestThreadRecoveryMutation"];
  recordDecisionMutation: Mutations["recordDecisionMutation"];
  cancelRunMutation: Mutations["cancelRunMutation"];

  /* --- state the dispatch writes back ----------------------------------- */
  setActiveAgent: (agent: AgentName) => void;
  setActiveLogicalAgentId: (id: string | null) => void;
  setActiveSessionId: (id: string | null) => void;
  setSelectedSessionId: (id: string | undefined) => void;
  setComposingNew: (value: boolean) => void;
  setPendingThreadTeamId: (id: string | null) => void;
  setPendingUserMessage: (message: { id: string; text: string } | null) => void;
  setIsRunning: (value: boolean) => void;
  setHandoffNote: (note: string) => void;
  setHandoffOpen: (open: boolean) => void;
  syncThreadUrl: (sessionId: string | null, replace?: boolean, projectId?: string | null) => void;
  navigateToRoute: (route: AppRoute) => void;

  /* --- reporting -------------------------------------------------------- */
  reportMutationError: (label: string, error: unknown, message: string) => void;
  t: TFunction;
}

export function useThreadDispatch(deps: ThreadDispatchDeps) {
  const pendingDispatch = useRef<{ sessionId: string | undefined; stopRequested: boolean } | null>(null);
  const {
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
  } = deps;

  async function sendMessage() {
    const raw = composerRef.current?.getText().trim() ?? "";
    if (!raw) return;
    if (!selectedEmployee) return;
    if (threadRunning) return;
    if (projectDispatchDisabled) return;
    if (requiresRuntimeSelection && !selectedThreadNodeId) {
      reportMutationError("Computer required", null, t("errors.thread_computer_required"));
      return;
    }
    // When staging a new thread, always create; otherwise continue the
    // open one. composingNew forces a fresh owner-scoped session here.
    const action = composingNew ? { kind: "create" as const } : chooseSendAction({ activeSessionId: activeSession?.id ?? null, session: activeSession });
    const sessionId = action.kind === "append" ? action.sessionId : undefined;
    const creatingSession = suppressActiveSessionDuringPendingSend(action);
    // A team picked while staging a new thread turns the message into a team
    // thread: no single-agent routing, the backend expands the roster.
    const pendingTeam = action.kind === "create" && pendingThreadTeamId
      ? composerTeams.find((team) => team.id === pendingThreadTeamId)
      : undefined;
    let goal = raw;
    let newThreadAgentIds: string[] | undefined;
    // A project round addresses the whole roster unless the composer (or a
    // mention) names one member — the backend expands whichever it is given.
    const projectRoomRound = Boolean(activeProject) && projectRoomTarget;
    // A mention overrides the footer selection. Team messages intentionally
    // default to the room; every single-agent message requires one valid
    // footer selection and never fails open to the room.
    const messageAddress = resolveThreadMessageAddress({
      text: raw,
      candidates: threadMentionCandidates,
      defaultAgentId: projectRoomRound || pendingTeam || activeSession?.teamId
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
      return;
    }
    // Participant availability is a creation concern. Continued threads send
    // semantic intent to the conductor, which resolves the room against live
    // membership and placement state on the server.
    if (!sessionId && !pendingTeam) {
      newThreadAgentIds = messageAddress.addressAgentIds;
    }
    // Echo the turn immediately. For a continued session we mint the message id
    // here and hand it to the backend so the persisted event reconciles by id.
    const messageOperationKey = sessionId
      ? threadMessageOperationKey({
          sessionId,
          text: goal,
          intent: "accomplish",
          addressAgentIds: messageAddress.addressAgentIds,
        })
      : null;
    const retainedMessageId = messageOperationKey
      ? messageOperationIdsRef.current.get(messageOperationKey)
      : null;
    const userMessageId = retainedMessageId ?? `evt_${crypto.randomUUID()}`;
    if (messageOperationKey && !retainedMessageId) {
      messageOperationIdsRef.current.set(messageOperationKey, userMessageId);
    }
    // While creating a fresh thread, keep suppressing the previous active
    // thread so the optimistic user turn does not appear in the wrong transcript.
    if (!creatingSession) setComposingNew(false);
    // Route synchronization clears any pending message when it reapplies an
    // existing session from the URL. Navigate before adding this optimistic
    // turn so that cleanup cannot erase the message in the same render batch.
    // The URL must name the thread this turn belongs to: a create stays on
    // /threads/new (so composingNew survives) and a continued send stays on
    // its own path. The bare /threads route parses as neither, which reset
    // composingNew and rendered the new turn inside the previously active
    // thread until the create resolved and snapped the view back.
    syncThreadUrl(sendThreadSessionId(action), true, activeProject?.id);
    setPendingUserMessage({ id: userMessageId, text: goal });
    setIsRunning(true);
    const dispatch = { sessionId, stopRequested: false };
    pendingDispatch.current = dispatch;
    composerRef.current?.clear();
    transcript.pinToBottom();
    try {
      const done = sessionId
        ? await submitThreadMessageMutation.mutateAsync({
            sessionId,
            input: threadMessageInput({
              text: goal,
              addressAgentIds: messageAddress.addressAgentIds,
              userMessageId,
            }),
          })
        : await runLogicalAgentsMutation.mutateAsync({
            taskGoal: goal,
            ...(activeProject ? { projectId: activeProject.id } : {}),
            ...(!activeProject && selectedThreadNodeId ? { daemonNodeId: selectedThreadNodeId } : {}),
            ...(activeProject
              ? newThreadAgentIds!.length
                ? { assignments: newThreadAgentIds!.map((agentId) => ({ agentId })) }
                : {}
              : pendingTeam
              ? { teamId: pendingTeam.id }
              : {
                  assignments: newThreadAgentIds!.map((agentId) => ({ agentId })),
                }),
          });
      setPendingThreadTeamId(null);
      setActiveSessionId(done.id);
      setSelectedSessionId(done.id);
      setComposingNew(false);
      syncThreadUrl(done.id, true, done.projectId ?? activeProject?.id);
      if (messageOperationKey) {
        messageOperationIdsRef.current.delete(messageOperationKey);
      }
      if (dispatch.stopRequested) {
        // Dispatch has accepted the run; cancelling earlier could only cancel
        // the previous turn (or have no thread ID at all).
        await cancelSessionRun(done.id, done.projectId);
      }
    } catch (error) {
      setPendingUserMessage(null);
      // The composer was cleared optimistically; a rejected dispatch (busy
      // node, offline runtime) is retryable, so hand the text back — exactly
      // as typed, mention included — instead of making the author retype it.
      if (!composerRef.current?.getText().trim()) composerRef.current?.setText(raw);
      reportMutationError(
        "Failed to send message",
        error,
        formatDispatchError(error, t) ?? t("errors.send_message"),
      );
    } finally {
      if (pendingDispatch.current === dispatch) pendingDispatch.current = null;
      setIsRunning(false);
    }
  }

  async function cancelActiveRun() {
    const dispatch = pendingDispatch.current;
    if (dispatch && dispatch.sessionId === activeSession?.id) {
      dispatch.stopRequested = true;
      return;
    }
    if (!activeSession) return;
    if (!canCancelThreadRun({ activeRun, session: activeSession })) return;
    await cancelSessionRun(activeRun?.sessionId ?? activeSession.id, activeSession.projectId);
  }

  async function cancelSessionRun(sessionId: string, projectId?: string | null) {
    const cancelNodeId = threadCancelNodeId({
      node: activeRunOwner?.node ?? activeRuntimeNode ?? undefined,
      sandbox: selectedSandbox,
    });
    try {
      const session = await cancelRunMutation.mutateAsync({
        sessionId,
        token: (cancelNodeId ? tokens[cancelNodeId] : undefined) ?? selectedToken,
        reason: t("cancel.reason"),
      });
      setSelectedSessionId(session.id);
      syncThreadUrl(session.id, true, session.projectId ?? projectId);
    } catch {
      // mutation onError surfaces a toast.
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
    failureLabel,
    failureMessageKey,
  }: {
    prefer?: string;
    fallback?: AgentName;
    kind: "rerun" | "handoff";
    note?: string;
    failureLabel: string;
    failureMessageKey: string;
  }) {
    if (!activeSession) return;
    if (!selectedEmployee) return;
    if (threadRunning) return;
    const logicalAgent = effectiveSelectableLogicalAgents.find(
      (candidate) => candidate.id === prefer && isEmployeeAgentRoutable(candidate),
    ) ?? (fallback
      ? effectiveSelectableLogicalAgents.find(
          (candidate) => candidate.executorKind === fallback && isEmployeeAgentRoutable(candidate),
        )
      : undefined);
    if (!logicalAgent) {
      reportMutationError(
        `Agent not ready for ${kind}`,
        null,
        t("errors.agent_not_ready", { agent: prefer ?? fallback }),
      );
      return;
    }
    setIsRunning(true);
    try {
      setActiveAgent(logicalAgent.executorKind);
      setActiveLogicalAgentId(logicalAgent.id);
      // A handoff is issued from the thread you are already reading, so it
      // does not navigate or re-pin; rerun and retry can both be triggered
      // from elsewhere and have to bring the thread into view first.
      if (kind === "rerun") {
        setSelectedSessionId(activeSession.id);
        navigateToRoute("main");
        transcript.pinToBottom();
      }
      const recoveryKey = note
        ? `${activeSession.id}:${kind}:${logicalAgent.id}:${note}`
        : `${activeSession.id}:${kind}:${logicalAgent.id}`;
      const done = await requestThreadRecoveryMutation.mutateAsync({
        sessionId: activeSession.id,
        input: {
          kind,
          idempotencyKey: recoveryOperationId(recoveryKey),
          targetAgentId: logicalAgent.id,
          ...(note ? { note } : {}),
        },
      });
      recoveryOperationIdsRef.current.delete(recoveryKey);
      setSelectedSessionId(done.id);
      if (kind === "handoff") {
        setHandoffNote("");
        setHandoffOpen(false);
      }
      syncThreadUrl(done.id, true, done.projectId ?? activeSession.projectId);
    } catch (error) {
      reportMutationError(
        failureLabel,
        error,
        formatDispatchError(error, t) ?? t(failureMessageKey),
      );
    } finally {
      setIsRunning(false);
    }
  }

  async function sendDecision(kind: "approve" | "reject" | "rerun" | "mark_done") {
    if (!activeSession) return;
    if (kind === "rerun") {
      const assignment = rerunAssignmentForSession(activeSession, activeAgent);
      await dispatchRecovery({
        prefer: assignment.agentId,
        fallback: assignment.agent,
        kind: "rerun",
        failureLabel: "Failed to rerun assignment",
        failureMessageKey: "errors.rerun_assignment",
      });
      return;
    }
    try {
      const session = await recordDecisionMutation.mutateAsync({
        sessionId: activeSession.id,
        kind,
        token: selectedToken,
      });
      setSelectedSessionId(session.id);
      syncThreadUrl(session.id, true, session.projectId ?? activeSession.projectId);
    } catch {
      // mutation onError surfaces a toast.
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

  async function sendHandoff() {
    await dispatchRecovery({
      prefer: handoffAgentId,
      kind: "handoff",
      note: handoffNote.trim() || undefined,
      failureLabel: "Failed to send handoff",
      failureMessageKey: "errors.send_handoff",
    });
  }


  return { sendMessage, cancelActiveRun, sendDecision, retryAgentMessage, sendHandoff };
}
