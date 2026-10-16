import type { RelaySession } from "../types.js";
import { isTerminalSessionStatus } from "./sessionEventStream.ts";
import { isAwaitingHuman } from "./workflow.ts";

export type HandoffStatus =
  | "accepted"
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

type RelayEvent = RelaySession["events"][number];
type Round = NonNullable<RelaySession["collaborationRounds"]>[number];
type Run = RelaySession["agentRuns"][number];

const FINISHED_RUN: ReadonlySet<Run["status"]> = new Set(["completed", "failed", "cancelled"]);

/**
 * Delivery evidence belongs to an assignment attempt, never to an executor kind.
 *
 * The round stays the thread's active one after it ends, so the panel follows
 * the thread too: once the thread is settled — finished, or parked on its
 * human — nothing is in progress any more. A handoff that failed or was
 * cancelled keeps its reason; one that completed, or never started, leaves
 * the thread's own outcome to speak.
 */
export function deriveHandoffStatus(session: RelaySession | undefined) {
  const round = session?.collaborationRounds?.find(
    (item) => item.roundId === session.activeRoundId,
  );
  const context = round?.handoffContext;
  if (!session || !round || !context) return null;
  const run = session.agentRuns
    .filter((item) => item.assignmentId === context.assignmentId)
    .at(-1);
  const settled = isTerminalSessionStatus(session.status) || isAwaitingHuman(session);
  let status: HandoffStatus;
  if (run && FINISHED_RUN.has(run.status)) {
    status = run.status as HandoffStatus;
  } else if (session.status === "failed" || session.status === "cancelled") {
    status = session.status;
  } else if (settled) {
    return null;
  } else {
    status = deliveryStatus(session.events, round, context.assignmentId, run);
  }
  if (status === "completed" && settled) return null;
  const cancellation = status === "cancelled"
    ? session.decisions.filter((decision) => decision.kind === "cancel").at(-1)?.note
    : undefined;
  return {
    status,
    target: context.targetDisplayName || context.targetAgentId || context.targetExecutor,
    note: context.note,
    reason: status === "failed" || status === "cancelled"
      ? cancellation || session.finalOutcome
      : undefined,
  };
}

/**
 * Latest delivery state of the handoff's attempt. Running is sticky — a late
 * `queued` frame cannot undo execution evidence. Scans back from the newest
 * event and stops at the round's own start, since nothing before it can
 * belong to this round.
 */
function deliveryStatus(
  events: readonly RelayEvent[],
  round: Round,
  assignmentId: string,
  run: Run | undefined,
): HandoffStatus {
  let latest: HandoffStatus | undefined;
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]!;
    if (event.type === "collaboration.round.started" && event.manifest.roundId === round.roundId) break;
    if (
      event.type === "collaboration.delivery"
      && event.roundId === round.roundId
      && event.assignmentId === assignmentId
      && (!run || event.runId === run.id)
    ) {
      if (event.status === "running") return "running";
      latest ??= event.status;
    }
    // Older daemons do not acknowledge execution. Their output is evidence;
    // agent.started alone only proves backend staging.
    if (
      run
      && (event.type === "agent.output" || event.type === "agent.output.batch" || event.type === "agent.collaboration")
      && event.runId === run.id
    ) {
      return "running";
    }
  }
  return latest ?? "accepted";
}
