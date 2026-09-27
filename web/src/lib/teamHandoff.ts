import type { AgentName, RelaySession } from "../types.js";

type Round = NonNullable<RelaySession["collaborationRounds"]>[number];
type Run = RelaySession["agentRuns"][number];

export interface TeamHandoff {
  /** Logical agent that just finished; absent on legacy runs. */
  fromAgentId: string | undefined;
  fromAgent: AgentName;
  /** Teammate the round advances to, or null when the conductor decides. */
  toAgentId: string | null;
  /** When the previous turn ended — the start of the quiet gap. */
  since: string | undefined;
}

/**
 * The quiet gap in a team round between one member finishing and the next
 * member's run appearing. Nothing streams during it, so without a cue the
 * thread reads as stuck. Once the next run is staged its own turn (with the
 * transcript's handoff divider) takes over, so this returns null again.
 *
 * The target is a prediction from the round manifest — assignments run in
 * order, and a build/review reviewer asking for changes sends the work back
 * to the builder. When the manifest has nothing left, the target stays open
 * rather than guessing.
 */
export function deriveTeamHandoff(session: RelaySession | null | undefined): TeamHandoff | null {
  if (!session || session.status !== "running") return null;
  const round = session.collaborationRounds?.find((item) => item.roundId === session.activeRoundId);
  if (!round || round.assignments.length < 2) return null;
  const runs = session.agentRuns ?? [];
  if (runs.some((item) => item.status === "running")) return null;

  const assignmentIds = new Set(round.assignments.map((item) => item.assignmentId));
  const last = runs.filter((item) => !item.consultation && item.assignmentId && assignmentIds.has(item.assignmentId)).at(-1);
  if (!last || last.status !== "completed") return null;

  return {
    fromAgentId: last.logicalAgentId,
    fromAgent: last.agent,
    toAgentId: nextAssignee(round, last),
    since: last.completedAt,
  };
}

function nextAssignee(round: Round, last: Run): string | null {
  const index = round.assignments.findIndex((item) => item.assignmentId === last.assignmentId);
  const role = last.role ?? round.assignments[index]?.role;
  const changesRequested = role === "reviewer"
    && last.workResult?.status === "continue"
    && Boolean(last.workResult.findings?.length);
  if (round.style === "build_review" && changesRequested) {
    const builder = round.assignments.find((item) => item.role === "implementer" || item.role === "fixer");
    if (builder) return builder.agentId;
  }
  return round.assignments[index + 1]?.agentId ?? null;
}
