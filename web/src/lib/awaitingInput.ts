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
  /** Acceptance-gate reasons the question stood in front of — not what to
   *  answer, but what the person answering should know. */
  notes: string[];
  /** The turn that stopped — who is waiting on the answer. */
  run?: RelaySession["agentRuns"][number];
  /** The task the reply resumes, when the thread is that task's room. */
  task?: RelayTaskListItem;
};

type InputRequest = { inputQuestion?: string; inputOptions?: string[]; inputNotes?: string[] };

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
  const scope = session.collaborationRounds?.find((round) => round.roundId === session.activeRoundId)?.workScope;
  const task = waitingTask(session, scope, tasks);
  if (!task) {
    // The round ran for a task that is not waiting here (anymore): answered
    // in another thread, moved on the board, or done. Its old blocked outcome
    // is history, not a question.
    if (scope?.kind === "task") return null;
    if (session.workOutcome !== "blocked") return null;
  }
  const run = session.agentRuns.at(-1);
  // The task keeps the question across turns in between; a wait recorded
  // before tasks carried it still has it on this thread's last completion.
  const request: InputRequest = task?.waitingRequest ?? session;
  const question = request.inputQuestion?.trim() || null;
  // Lists in prose may be requested details or steps, rather than alternatives.
  // Only structured options are safe to send as complete answers.
  const offered = distinctOptions(request.inputOptions ?? []);
  const options = offered.length >= OPTIONS_MIN ? offered : [];
  const notes = (request.inputNotes ?? []).map((note) => note.trim()).filter(Boolean);
  // Records written before the structured question carry it in the outcome.
  const reason = readWaitingReason(task?.waitingReason ?? session.finalOutcome);
  if (!question && !options.length && reason.kind === "check") return { ...reason, options: [], notes: [], run, task };
  return {
    kind: "question",
    text: question ?? (reason.kind === "question" ? reason.text : null),
    options,
    notes,
    run,
    task,
  };
}

/**
 * The task a reply in this thread resumes — the backend's rule
 * (`CollaborationConductor._awaiting_task`). A wait that names its thread
 * wins, so a status question asked in between does not orphan it; older waits
 * fall back to the active round's task. Historical links never count.
 */
function waitingTask(
  session: RelaySession,
  scope: NonNullable<RelaySession["collaborationRounds"]>[number]["workScope"] | undefined,
  tasks: readonly RelayTaskListItem[],
): RelayTaskListItem | undefined {
  const resumable = (item: RelayTaskListItem) => item.status === "waiting_for_human" && !item.isRoutine && !item.deletedAt;
  const named = tasks.find((item) => item.waitingSessionId === session.id && resumable(item));
  if (named) return named;
  if (scope?.kind !== "task") return undefined;
  return tasks.find((item) => (
    item.id === scope.taskId && resumable(item) && (!item.waitingSessionId || item.waitingSessionId === session.id)
  ));
}

/** What a waiting task asks, for surfaces that show the task, not its thread. */
export function taskWaitingPrompt(task: Pick<RelayTaskListItem, "waitingReason" | "waitingRequest">): Pick<AwaitingInput, "kind" | "text" | "notes"> {
  const question = task.waitingRequest?.inputQuestion?.trim();
  const notes = (task.waitingRequest?.inputNotes ?? []).map((note) => note.trim()).filter(Boolean);
  if (question) return { kind: "question", text: question, notes };
  return { ...readWaitingReason(task.waitingReason), notes };
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
