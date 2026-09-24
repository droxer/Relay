import type { RelaySession, TokenUsage } from "../types.js";

type RelayEvent = RelaySession["events"][number];

function mergeRunTokenUsage(values: Array<TokenUsage | undefined>): TokenUsage | undefined {
  const totals = { input: 0, output: 0, cache: 0 };
  for (const value of values) {
    if (!value) continue;
    totals.input += value.input;
    totals.output += value.output;
    totals.cache += value.cache;
  }
  if (totals.input === 0 && totals.output === 0 && totals.cache === 0) return undefined;
  return { ...totals, total: totals.input + totals.output + totals.cache };
}

export function applySessionEvent(session: RelaySession, event: RelayEvent): RelaySession {
  if (session.events.some((existing) => existing.id === event.id)) return session;
  return applySessionEventUnchecked(session, event);
}

/** Apply an event whose id was already checked by a batch-level Set. */
export function applySessionEventUnchecked(session: RelaySession, event: RelayEvent): RelaySession {
  return applySessionEventsUnchecked(session, [event]);
}

/** Apply a deduplicated SSE batch while copying the growing event list once. */
export function applySessionEventsUnchecked(session: RelaySession, events: RelayEvent[]): RelaySession {
  if (events.length === 0) return session;
  let next: RelaySession = {
    ...session,
    events: [...session.events, ...events],
  };
  for (const event of events) next = applySessionEventProjection(next, event);
  return next;
}

function applySessionEventProjection(session: RelaySession, event: RelayEvent): RelaySession {
  const next: RelaySession = {
    ...session,
    updatedAt: event.timestamp,
  };

  // A newly accepted run supersedes the last polled execution summary.
  // Keep deletion intent, which remains authoritative across every run event.
  if (event.type === "agent.started" || (event.type === "session.status" && event.status === "running")) {
    delete next.execution;
  }

  switch (event.type) {
    case "collaboration.round.started": {
      const existingRounds = next.collaborationRounds ?? [];
      const collaborationRounds = existingRounds.some(
        (round) => round.roundId === event.manifest.roundId,
      )
        ? existingRounds
        : [...existingRounds, event.manifest];
      return {
        ...next,
        collaborationRounds,
        collaborationRevision: collaborationRounds.length,
        activeCollaborationId: event.manifest.collaborationId,
        activeRoundId: event.manifest.roundId,
      };
    }
    case "session.status":
      {
        const updated: RelaySession = {
          ...next,
          status: event.status,
          phase: event.phase,
        };
        if (event.pendingDecision) {
          updated.pendingDecision = event.pendingDecision;
        } else {
          delete updated.pendingDecision;
        }
        if (event.status !== "completed" && event.status !== "failed") {
          delete updated.finalOutcome;
          delete updated.workOutcome;
        }
        return updated;
      }
    case "agent.started": {
      delete next.workOutcome;
      if (next.agentRuns.some((run) => run.id === event.runId)) {
        return { ...next, status: "running", phase: event.agent, currentAgent: event.agent };
      }
      return {
        ...next,
        status: "running",
        phase: event.agent,
        currentAgent: event.agent,
        agentRuns: [
          ...next.agentRuns,
          {
            id: event.runId,
            ...(event.consultation ? { consultation: true } : {}),
            ...(event.assignmentId ? { assignmentId: event.assignmentId } : {}),
            ...(event.workItemId ? { workItemId: event.workItemId } : {}),
            ...(event.delegationAuthority ? { delegationAuthority: event.delegationAuthority } : {}),
            ...(event.dependsOnWorkItemIds ? { dependsOnWorkItemIds: event.dependsOnWorkItemIds } : {}),
            ...(event.workKind ? { workKind: event.workKind } : {}),
            agent: event.agent,
            ...(event.logicalAgentId ? { logicalAgentId: event.logicalAgentId } : {}),
            ...(event.placementId ? { placementId: event.placementId } : {}),
            ...(event.daemonNodeId ? { daemonNodeId: event.daemonNodeId } : {}),
            ...(event.agentVersion !== undefined ? { agentVersion: event.agentVersion } : {}),
            ...(event.workspaceIdentity ? { workspaceIdentity: event.workspaceIdentity } : {}),
            ...(event.role ? { role: event.role } : {}),
            ...(event.brief ? { brief: event.brief } : {}),
            ...(event.coordinator ? { coordinator: true } : {}),
            ...(event.synthesizer ? { synthesizer: true } : {}),
            ...(event.teamSnapshot ? { teamSnapshot: event.teamSnapshot } : {}),
            ...(event.teamPhase ? { teamPhase: event.teamPhase } : {}),
            status: "running",
            startedAt: event.timestamp,
            artifactIds: [],
          },
        ],
      };
    }
    case "agent.completed": {
      const agentRuns = next.agentRuns.map((run) => run.id === event.runId
        ? {
            ...run,
            status: event.status,
            completedAt: event.timestamp,
            exitCode: event.exitCode,
            ...(event.workResult ? { workResult: event.workResult } : {}),
            ...(event.agentLog !== undefined ? { agentLog: event.agentLog } : {}),
            ...(event.tokenUsage ? { tokenUsage: event.tokenUsage } : {}),
          }
        : run);
      {
        const updated: RelaySession = {
          ...next,
          agentRuns,
          phase: event.status === "completed"
            ? "agent_completed"
            : event.status === "cancelled" ? "cancelled" : "agent_failed",
        };
        const tokenUsage = mergeRunTokenUsage(agentRuns.map((run) => run.tokenUsage));
        if (tokenUsage) {
          updated.tokenUsage = tokenUsage;
        } else {
          delete updated.tokenUsage;
        }
        delete updated.currentAgent;
        return updated;
      }
    }
    case "artifact.created": {
      const artifacts = next.artifacts.some((artifact) => artifact.id === event.artifact.id)
        ? next.artifacts
        : [...next.artifacts, event.artifact];
      const agentRuns = event.artifact.agentRunId
        ? next.agentRuns.map((run) => run.id === event.artifact.agentRunId && !run.artifactIds.includes(event.artifact.id)
            ? { ...run, artifactIds: [...run.artifactIds, event.artifact.id] }
            : run)
        : next.agentRuns;
      return { ...next, artifacts, agentRuns };
    }
    case "human.decision":
      {
        const updated: RelaySession = {
          ...next,
          decisions: next.decisions.some((decision) => decision.id === event.decision.id)
            ? next.decisions
            : [...next.decisions, event.decision],
          ...(event.decision.kind === "handoff" && event.decision.targetAgent ? { currentAgent: event.decision.targetAgent } : {}),
          ...(event.decision.kind === "cancel" ? { status: "cancelled" as const, phase: "cancelled" } : {}),
        };
        if (event.decision.kind === "cancel") {
          delete updated.pendingDecision;
          delete updated.workOutcome;
        }
        return updated;
      }
    case "session.completed":
      {
        const updated: RelaySession = { ...next, status: "completed", phase: "completed", finalOutcome: event.outcome, workOutcome: event.workOutcome ?? "unverified" };
        delete updated.currentAgent;
        delete updated.pendingDecision;
        return updated;
      }
    case "session.failed":
      {
        const updated: RelaySession = { ...next, status: "failed", phase: "failed", finalOutcome: event.outcome, workOutcome: "blocked" };
        delete updated.currentAgent;
        delete updated.pendingDecision;
        return updated;
      }
    case "session.archived":
      return { ...next, archived: true };
    case "session.deletion_requested":
      return { ...next, deletionRequestedAt: next.deletionRequestedAt ?? event.timestamp, deletionRequestedBy: next.deletionRequestedBy ?? event.requestedBy };
    case "session.renamed":
      return { ...next, title: event.title };
    default:
      return next;
  }
}
