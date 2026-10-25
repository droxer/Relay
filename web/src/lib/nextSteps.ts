import type { RelaySession } from "../types.js";

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
