import type { AgentName, RelaySession } from "../types.js";

type Round = NonNullable<RelaySession["collaborationRounds"]>[number];
type Run = RelaySession["agentRuns"][number];

export interface TeamHandoff {
  /** Run that ended — identifies this gap. */
  fromRunId: string;
  /** Logical agent that just finished; absent on legacy runs. */
  fromAgentId: string | undefined;
  fromAgent: AgentName;
  /** Teammate the round advances to, or null when it cannot be read off the
   * round — the conductor decides, and a wrong name is worse than none. */
  toAgentId: string | null;
  /** How the previous turn ended. A failed turn the thread keeps running
   * through is being repaired or skipped, not handed on as done work. */
  outcome: "completed" | "failed";
  /** When the previous turn ended — the start of the quiet gap. */
  since: string | undefined;
}

/**
 * The quiet gap in a team round between one member's turn ending and the
 * next member's run appearing. Nothing streams during it — and it lasts
 * whenever the computer has no free slot — so without a cue the thread reads
 * as stuck. Once the next run is staged its own turn takes over.
 */
export function deriveTeamHandoff(session: RelaySession | null | undefined): TeamHandoff | null {
  if (!session || session.status !== "running") return null;
  const round = session.collaborationRounds?.find((item) => item.roundId === session.activeRoundId);
  if (!round || round.assignments.length < 2) return null;
  const runs = session.agentRuns ?? [];
  if (runs.some((item) => item.status === "running")) return null;

  const assignmentIds = new Set(round.assignments.map((item) => item.assignmentId));
  const last = runs.filter((item) => !item.consultation && item.assignmentId && assignmentIds.has(item.assignmentId)).at(-1);
  if (!last || (last.status !== "completed" && last.status !== "failed")) return null;

  return {
    fromRunId: last.id,
    fromAgentId: last.logicalAgentId,
    fromAgent: last.agent,
    toAgentId: last.status === "completed" ? nextAssignee(round, last) : null,
    outcome: last.status,
    since: last.completedAt,
  };
}

/** Owner of a work item; like the backend, an item id falls back to the
 * assignment id on rounds without a work graph. */
function ownerOf(round: Round, workItemId: string | undefined): string | undefined {
  if (!workItemId) return undefined;
  return round.workGraph?.items.find((item) => item.workItemId === workItemId)?.ownerAgentId
    ?? round.assignments.find((item) => item.assignmentId === workItemId)?.agentId;
}

/**
 * Read the next assignee off the same signals the backend conductor routes on
 * (daemon_registry `question_transition` → `repair_transition` → advance):
 * an answer resumes the asker, a question consults the named teammate,
 * findings send work back to the earliest cited owner, and only a `done`
 * result advances in manifest order. Anything else ends or re-plans the
 * round, so the target stays open.
 */
function nextAssignee(round: Round, last: Run): string | null {
  const index = round.assignments.findIndex((item) => item.assignmentId === last.assignmentId);
  const result = last.workResult;
  const inOrder = round.assignments[index + 1]?.agentId ?? null;
  if (!result) return inOrder;

  const messageTarget = (kind: "answer" | "question") =>
    ownerOf(round, result.messages?.find((message) => message.kind === kind)?.toWorkItemId);
  if (result.status === "done") return messageTarget("answer") ?? inOrder;
  const asked = messageTarget("question");
  if (asked) return asked;
  if (result.status !== "continue" || !result.findings?.length) return null;
  const cited = new Set(result.findings.map((finding) => ownerOf(round, finding.workItemId)));
  return round.assignments.find((item) => cited.has(item.agentId))?.agentId ?? null;
}
