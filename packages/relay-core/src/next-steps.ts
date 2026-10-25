/**
 * Suggested next steps: follow-up requests a finished run offers its person.
 *
 * The run writes them to a private control file; the daemon reports them on
 * `run.completed`, the backend keeps them on `session.completed`, and the
 * thread offers each as a one-click reply. The text is agent-written, so
 * every side bounds it with the same limits
 * (`backend/tests/unit/test_next_steps_parity.py`).
 */

/** Workspace-relative control file a run may write its suggestions to. */
export const NEXT_STEPS_RELATIVE_PATH = ".relay/next-steps.json";
export const NEXT_STEPS_MAX = 3;
export const NEXT_STEP_MAX_CHARS = 160;

/** Trimmed, whitespace-collapsed, distinct, and bounded; anything else is dropped. */
export function sanitizeNextSteps(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const steps: string[] = [];
  for (const item of raw) {
    if (typeof item !== "string") continue;
    const text = item.split(/\s+/).filter(Boolean).join(" ").slice(0, NEXT_STEP_MAX_CHARS);
    if (text && !steps.includes(text)) steps.push(text);
    if (steps.length === NEXT_STEPS_MAX) break;
  }
  return steps;
}
