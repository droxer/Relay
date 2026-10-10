import type { RelaySession, RelayTaskListItem } from "../types.js";
import { isAwaitingFeedbackDecision } from "./workflow.ts";

/**
 * The preamble the backend puts before a blocked round's own note
 * (`_round_outcome` in backend/relay/daemon_registry/registry.py). What
 * follows it is the agent's words — the thing a person has to answer.
 */
const BLOCKED_ROUND_PREAMBLE = "The round reported it is blocked.";

export type AwaitingInput = {
  /** `question`: the agent stopped to ask. `check`: a gate stopped the round
   *  (missing evidence, no verdict) and a person decides what happens next. */
  kind: "question" | "check";
  /** The agent's question, or the recorded reason; null when the agent asked
   *  for help without saying what it needs. */
  text: string | null;
  /** The turn that stopped — who is waiting on the answer. */
  run?: RelaySession["agentRuns"][number];
  /** The task the reply resumes, when the thread is that task's room. */
  task?: RelayTaskListItem;
};

/**
 * Whether this thread is parked on its human, and on what.
 *
 * A blocked round closes its session as `completed` with `workOutcome:
 * "blocked"` and parks the task at `waiting_for_human`; neither state alone
 * drew anything, so the thread looked finished. A reply resumes the work
 * (the backend runs it as the task's next round), so the reply box is the
 * answer and this is the prompt for it.
 */
export function awaitingInput(
  session: RelaySession | undefined,
  tasks: readonly RelayTaskListItem[],
): AwaitingInput | null {
  if (!session || session.status !== "completed") return null;
  // A rejected turn already has its own controls (the decision bar).
  if (isAwaitingFeedbackDecision(session)) return null;
  // Historical links do not grant task ownership. Match the conductor's
  // active-round scope before promising that a reply resumes a task.
  const scope = session.collaborationRounds?.find((round) => round.roundId === session.activeRoundId)?.workScope;
  const task = scope?.kind === "task" ? tasks.find((item) => (
    item.id === scope.taskId && item.status === "waiting_for_human" && !item.isRoutine && !item.deletedAt
  )) : undefined;
  if (!task && session.workOutcome !== "blocked") return null;
  const run = session.agentRuns.at(-1);
  return { ...readWaitingReason(task?.waitingReason ?? session.finalOutcome), run, task };
}

/** Split a recorded waiting reason into what kind of wait it is and the words
 *  worth quoting. Shared by the thread prompt and the task record. */
export function readWaitingReason(raw: string | undefined): Pick<AwaitingInput, "kind" | "text"> {
  const reason = (raw ?? "").trim();
  if (reason.startsWith(BLOCKED_ROUND_PREAMBLE)) {
    const question = reason.slice(BLOCKED_ROUND_PREAMBLE.length).trim();
    return { kind: "question", text: question || null };
  }
  return { kind: "check", text: reason || null };
}
