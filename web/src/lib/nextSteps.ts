import type { CreateTaskInput, RelaySession, RelayTaskListItem } from "../types.js";

/** Bounds mirrored from relay-core's `next-steps.ts` and the backend's
 *  `core/next_steps.py` (`backend/tests/unit/test_next_steps.py`). */
const NEXT_STEPS_MAX = 3;
const NEXT_STEP_MAX_CHARS = 160;

/**
 * The follow-up requests a finished turn suggested, when the thread is free to
 * take one: never while a run is going, a person is being asked something, or
 * a message is already waiting to start. The text is agent-written, so it is
 * bounded again here rather than trusted.
 */
export function threadNextSteps(
  session: RelaySession | undefined,
  { busy }: { busy: boolean },
): string[] {
  if (!session || busy || session.status !== "completed") return [];
  if (session.events.at(-1)?.type === "user.message") return [];
  const steps: string[] = [];
  for (const item of session.nextSteps ?? []) {
    if (typeof item !== "string") continue;
    const text = item.split(/\s+/).filter(Boolean).join(" ").slice(0, NEXT_STEP_MAX_CHARS);
    if (text && !steps.includes(text)) steps.push(text);
    if (steps.length === NEXT_STEPS_MAX) break;
  }
  return steps;
}

/**
 * The task a suggestion becomes when the person adopts it: a backlog task in
 * the thread's project, or an issue with no project yet for a thread outside
 * one. It is left unassigned and unstarted — adopting records the work, the
 * person decides who does it and when.
 */
export function nextStepTaskInput(step: string, projectId: string | null): CreateTaskInput {
  return { title: step, ...(projectId ? { projectId } : {}) };
}

/**
 * The live task an adopted suggestion already became in this scope, so the
 * row says where it went instead of offering to create it twice.
 */
export function adoptedNextStepTask(
  step: string,
  tasks: readonly RelayTaskListItem[],
  projectId: string | null,
): RelayTaskListItem | undefined {
  return tasks.find((task) => !task.isRoutine
    && !task.deletedAt
    && task.title === step
    && (task.projectId ?? null) === projectId);
}
