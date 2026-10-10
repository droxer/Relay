import type { AgentName, RelaySession } from "../types.js";

export function isAwaitingFeedbackDecision(session: RelaySession | undefined): boolean {
  return session?.status === "waiting_for_human" && session.pendingDecision === "feedback";
}

/**
 * Whether the thread is parked on its human. Two shapes mean that: a rejected
 * turn (`waiting_for_human`), and a round that stopped to ask — the backend
 * closes that session `completed` with `workOutcome: "blocked"` and parks its
 * task at `waiting_for_human` (`session_awaits_human` on the backend). A
 * failed session also reads `blocked`, so the status has to be `completed`.
 */
export function isAwaitingHuman(session: Pick<RelaySession, "status" | "workOutcome"> | undefined): boolean {
  if (!session) return false;
  return session.status === "waiting_for_human"
    || (session.status === "completed" && session.workOutcome === "blocked");
}

// A rerun repeats the last turn, so it must target the same *named* agent —
// the executor kind alone would let another agent on that kind pick it up.
export function rerunAssignmentForSession(
  session: RelaySession,
  fallbackAgent: AgentName,
): { agent: AgentName; agentId?: string } {
  const lastRun = session.agentRuns[session.agentRuns.length - 1];
  return {
    agent: lastRun?.agent ?? session.currentAgent ?? fallbackAgent,
    ...(lastRun?.logicalAgentId ? { agentId: lastRun.logicalAgentId } : {}),
  };
}
