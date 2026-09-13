import type { RelaySession } from "../types.js";

export type HandoffStatus =
  | "accepted"
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

/** Delivery evidence belongs to an assignment attempt, never to an executor kind. */
export function deriveHandoffStatus(session: RelaySession | undefined) {
  const round = session?.collaborationRounds?.find(
    (item) => item.roundId === session.activeRoundId,
  );
  const context = round?.handoffContext;
  if (!session || !round || !context) return null;
  const run = session.agentRuns
    .filter((item) => item.assignmentId === context.assignmentId)
    .at(-1);
  let status: HandoffStatus = "accepted";
  if (run && (run.status === "completed" || run.status === "failed" || run.status === "cancelled")) {
    status = run.status;
  } else if (session.status === "failed" || session.status === "cancelled") {
    status = session.status;
  } else {
    for (const event of session.events) {
      if (
        event.type === "collaboration.delivery"
        && event.roundId === round.roundId
        && event.assignmentId === context.assignmentId
        && (!run || event.runId === run.id)
      ) {
        if (event.status === "running" || status !== "running") status = event.status;
      }
      // Older daemons do not acknowledge execution. Their output is evidence;
      // agent.started alone only proves backend staging.
      if (
        run
        && (event.type === "agent.output" || event.type === "agent.output.batch" || event.type === "agent.collaboration")
        && event.runId === run.id
      ) {
        status = "running";
      }
    }
  }
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
