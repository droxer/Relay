import type { TaskAwaiting } from "relay-core";
import type { RelaySession, RelayTaskListItem } from "../types.js";
import { isAwaitingFeedbackDecision } from "./workflow.ts";

/**
 * The preamble the backend puts before a blocked round's own note
 * (`_round_outcome` in backend/relay/daemon_registry/registry.py). Only a
 * thread with no task still reads it: a task's wait arrives projected.
 */
const BLOCKED_ROUND_PREAMBLE = "The round reported it is blocked.";
/** A gate stop's preamble (`WORK_NEEDS_ATTENTION` in
 *  backend/relay/collaboration/work.py). The prompt's title already says the
 *  work stopped, so it is not worth quoting. */
const GATE_PREAMBLE = "The work can't be accepted yet.";
/** Bounds mirrored from `round_result_options` (backend/relay/collaboration/policy.py). */
const OPTIONS_MIN = 2;
const OPTIONS_MAX = 6;
/** Per-option length, mirrored from `ROUND_RESULT_OPTION_MAX_CHARS` there. */
const OPTION_MAX_CHARS = 200;

export type AwaitingInput = {
  /** `question`: the agent stopped to ask. `check`: a gate stopped the round
   *  (missing evidence, no verdict) and a person decides what happens next.
   *  `budget`: the task used its continuation rounds. */
  kind: TaskAwaiting["kind"];
  /** The agent's question, or the recorded reason; null when the agent asked
   *  for help without saying what it needs. */
  text: string | null;
  /** Answers the agent offered, each sendable as is. Empty for an open
   *  question; a check's choices are the surface's own. */
  options: string[];
  /** Acceptance-gate reasons the question stood in front of — not what to
   *  answer, but what the person answering should know. */
  notes: string[];
  /** The wait a reply answers. An answer names it, so a stale reply is
   *  refused rather than answering whatever the task asks next. Absent for a
   *  thread-only wait or one recorded before waits carried ids. */
  questionId?: string;
  /** The turn that stopped — who is waiting on the answer. */
  run?: RelaySession["agentRuns"][number];
  /** The task the reply resumes, when the thread is that task's room. */
  task?: RelayTaskListItem;
};

/**
 * Whether this thread is parked on its human, and on what.
 *
 * A blocked round closes its session as `completed` and parks the task at
 * `waiting_for_human`; the backend projects that wait onto the task
 * (`awaiting`, from `task_awaiting`), so this only finds the task waiting in
 * this thread and renders it. A reply resumes the work, so the reply box is
 * the answer and this is the prompt for it.
 */
export function awaitingInput(
  session: RelaySession | undefined,
  tasks: readonly RelayTaskListItem[],
): AwaitingInput | null {
  if (!session || session.status !== "completed") return null;
  // A rejected turn already has its own controls (the decision bar).
  if (isAwaitingFeedbackDecision(session)) return null;
  const wait = threadWait(session, tasks);
  if (!wait) return null;
  const run = session.agentRuns.at(-1);
  if (!wait.task) return { ...sessionWait(session), run };
  const { awaiting, task } = wait;
  return {
    kind: awaiting.kind,
    text: awaiting.text,
    options: awaiting.options,
    notes: awaiting.notes,
    ...(awaiting.questionId ? { questionId: awaiting.questionId } : {}),
    run,
    task,
  };
}

/**
 * Whether a thread belongs in "needs you" — the prompt's own rule, so the
 * rail and the composer never disagree. A pending decision is the thread's
 * own; a settled thread waits when `threadWait` says it does.
 */
export function threadAwaitsHuman(
  session: RelaySession | undefined,
  tasks: readonly RelayTaskListItem[],
): boolean {
  if (!session) return false;
  if (session.status === "waiting_for_human") return true;
  return session.status === "completed" && threadWait(session, tasks) !== null;
}

type ThreadWait =
  | { task: RelayTaskListItem; awaiting: TaskAwaiting }
  | { task?: undefined };

/**
 * What a settled thread waits on, or null when it does not. A task whose wait
 * names this thread is the answer — the backend's `_awaiting_task` rule. A
 * wait recorded before waits named their thread falls back to the active
 * round's task. Otherwise a task the list holds for the active round has moved
 * on, so the old blocked outcome is history; a task the list does not hold
 * (not loaded yet, or not the viewer's) proves nothing, and a thread with no
 * task speaks for itself.
 */
function threadWait(session: RelaySession, tasks: readonly RelayTaskListItem[]): ThreadWait | null {
  for (const task of tasks) {
    const awaiting = resumableWait(task);
    if (awaiting?.sessionId === session.id) return { task, awaiting };
  }
  const scope = session.collaborationRounds?.find((round) => round.roundId === session.activeRoundId)?.workScope;
  const scoped = scope?.kind === "task" ? tasks.find((item) => item.id === scope.taskId) : undefined;
  if (!scoped) return session.workOutcome === "blocked" ? {} : null;
  const legacy = resumableWait(scoped);
  return legacy && !legacy.sessionId ? { task: scoped, awaiting: legacy } : null;
}

function resumableWait(task: RelayTaskListItem): TaskAwaiting | null {
  const { awaiting } = task;
  return awaiting?.resumable && !task.deletedAt && task.status === "waiting_for_human" ? awaiting : null;
}

/** A wait recorded only on its thread: a round with no task behind it. */
function sessionWait(session: RelaySession): Pick<AwaitingInput, "kind" | "text" | "options" | "notes"> {
  const question = session.inputQuestion?.trim() || null;
  // Lists in prose may be requested details or steps, rather than alternatives.
  // Only structured options are safe to send as complete answers.
  const offered = distinctOptions(session.inputOptions ?? []);
  const options = offered.length >= OPTIONS_MIN ? offered : [];
  const notes = (session.inputNotes ?? []).map((note) => note.trim()).filter(Boolean);
  const outcome = (session.finalOutcome ?? "").trim();
  const asked = outcome.startsWith(BLOCKED_ROUND_PREAMBLE);
  if (question || options.length || asked) {
    const quoted = asked ? outcome.slice(BLOCKED_ROUND_PREAMBLE.length).trim() || null : null;
    return { kind: "question", text: question ?? quoted, options, notes };
  }
  const reason = outcome.startsWith(GATE_PREAMBLE) ? outcome.slice(GATE_PREAMBLE.length).trim() : outcome;
  return { kind: "check", text: reason || null, options: [], notes };
}

/**
 * The thread a waiting task waits in — where a reply resumes it, which need
 * not be its newest link (a status question asked elsewhere adds one).
 * Undefined when the task is not waiting or never recorded where.
 */
export function taskWaitingThreadId(task: Pick<RelayTaskListItem, "awaiting">): string | undefined {
  return task.awaiting?.sessionId ?? undefined;
}

/** What a waiting task asks, for surfaces that show the task, not its thread. */
export function taskWaitingPrompt(
  task: Pick<RelayTaskListItem, "awaiting">,
): Pick<AwaitingInput, "kind" | "text" | "notes"> | null {
  const { awaiting } = task;
  return awaiting ? { kind: awaiting.kind, text: awaiting.text, notes: awaiting.notes } : null;
}

function distinctOptions(raw: readonly string[]): string[] {
  const options: string[] = [];
  for (const item of raw) {
    const option = item.replace(/\s+/g, " ").trim().slice(0, OPTION_MAX_CHARS);
    if (option && !options.includes(option)) options.push(option);
  }
  return options.slice(0, OPTIONS_MAX);
}
