import type { RelaySession, RelayTaskListItem } from "../types.js";
import { isAwaitingFeedbackDecision } from "./workflow.ts";

/**
 * The preamble the backend puts before a blocked round's own note
 * (`_round_outcome` in backend/relay/daemon_registry/registry.py). What
 * follows it is the agent's words — the thing a person has to answer.
 */
const BLOCKED_ROUND_PREAMBLE = "The round reported it is blocked.";
/** A gate stop's preamble (`WORK_NEEDS_ATTENTION` in
 *  backend/relay/collaboration/work.py), and the one it replaced. The prompt's
 *  title already says the work stopped, so neither is worth quoting. */
const GATE_PREAMBLES = ["The work can't be accepted yet.", "Work needs attention."];
/** Bounds mirrored from `round_result_options` (backend/relay/collaboration/policy.py). */
const OPTIONS_MIN = 2;
const OPTIONS_MAX = 6;

export type AwaitingInput = {
  /** `question`: the agent stopped to ask. `check`: a gate stopped the round
   *  (missing evidence, no verdict) and a person decides what happens next. */
  kind: "question" | "check";
  /** The agent's question, or the recorded reason; null when the agent asked
   *  for help without saying what it needs. */
  text: string | null;
  /** Answers the agent offered, each sendable as is. Empty for an open
   *  question; a check's choices are the surface's own. */
  options: string[];
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
  const reason = readWaitingReason(task?.waitingReason ?? session.finalOutcome);
  if (reason.kind === "check") return { ...reason, options: [], run, task };
  const offered = distinctOptions(session.inputOptions ?? []);
  if (offered.length >= OPTIONS_MIN) return { ...reason, options: offered, run, task };
  // Lists in prose may be requested details or steps, rather than alternatives.
  // Only structured options are safe to send as complete answers.
  return { ...reason, options: [], run, task };
}

/** Split a recorded waiting reason into what kind of wait it is and the words
 *  worth quoting. Shared by the thread prompt and the task record. */
export function readWaitingReason(raw: string | undefined): Pick<AwaitingInput, "kind" | "text"> {
  const reason = (raw ?? "").trim();
  if (reason.startsWith(BLOCKED_ROUND_PREAMBLE)) {
    const question = reason.slice(BLOCKED_ROUND_PREAMBLE.length).trim();
    return { kind: "question", text: question || null };
  }
  return { kind: "check", text: plainGateReason(reason) || null };
}

/**
 * A gate reason in words a person can act on. The backend now writes these
 * plainly; records written before it named internal assignment ids
 * ("Work 6fc1… is not accepted: missing."), which mean nothing to a reader.
 */
function plainGateReason(reason: string): string {
  const preamble = GATE_PREAMBLES.find((item) => reason.startsWith(item));
  if (!preamble) return reason;
  return reason.slice(preamble.length).trim()
    .replace(/Work \S+ is not accepted: (?:missing|missing evidence)\./g, "A required step ended without reporting what it did.")
    .replace(/Work \S+ is not accepted: done\./g, "A required step says it is done but showed no checks to back that up.")
    .replace(/Work \S+ is not accepted: (?:continue|blocked)\./g, "A required step is not finished.")
    .replace(/Work \S+ is not accepted: (.+?)\.(?=\s|$)/g, "A required step is not finished: $1.")
    .replace(/Required contribution \S+ failed\./g, "A required step failed to run.")
    .replace(/Unresolved finding on \S+: /g, "A review found a problem that is still open: ");
}

function distinctOptions(raw: readonly string[]): string[] {
  const options: string[] = [];
  for (const item of raw) {
    const option = item.replace(/\s+/g, " ").trim();
    if (option && !options.includes(option)) options.push(option);
  }
  return options.slice(0, OPTIONS_MAX);
}
