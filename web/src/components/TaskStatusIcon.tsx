import { cn } from "@/lib/utils";
import type { TaskStatus } from "../types";

/**
 * The one glyph for a task's lifecycle status, drawn the same on every surface
 * that shows one: the issue table, a row's status control and its menu, the
 * board's lane heads, group bands, and the record.
 *
 * A dot could not tell Ready from Review from "awaiting your input" — three
 * grey solids — so the glyph carries progress in its fill instead: a dashed
 * ring for work nobody has picked up, an empty ring when it is ready, a ring
 * filling as it moves (running half, review three quarters), a slashed ring
 * when it is stuck, and a filled check when it is done. The hue comes from
 * task-status.css, keyed off `data-status`, so the glyph never picks its own.
 */
const PROGRESS: Partial<Record<TaskStatus, number>> = {
  running: 0.5,
  waiting_for_human: 0.5,
  review: 0.75,
};

/* r=2.5 with a 5-wide stroke paints a disc of radius 5 whose dash length is
   the filled fraction — a pie without computing an arc path. */
const PIE_RADIUS = 2.5;
const PIE_CIRCUMFERENCE = 2 * Math.PI * PIE_RADIUS;

export function TaskStatusIcon({ status, className }: { status: TaskStatus; className?: string }) {
  const progress = PROGRESS[status];
  return (
    <svg
      viewBox="0 0 14 14"
      width="14"
      height="14"
      aria-hidden="true"
      focusable="false"
      className={cn("task-status-icon", className)}
      data-status={status}
    >
      {status === "done" ? (
        <>
          <circle cx="7" cy="7" r="6.25" fill="currentColor" />
          <path d="M4.4 7.2 6.2 9 9.7 5.3" fill="none" stroke="var(--surface-0)" strokeWidth="1.5"
            strokeLinecap="round" strokeLinejoin="round" />
        </>
      ) : (
        <circle cx="7" cy="7" r="6" fill="none" stroke="currentColor" strokeWidth="1.5"
          strokeDasharray={status === "backlog" ? "1.9 1.9" : undefined} />
      )}
      {progress ? (
        <circle cx="7" cy="7" r={PIE_RADIUS} fill="none" stroke="currentColor" strokeWidth={PIE_RADIUS * 2}
          strokeDasharray={`${progress * PIE_CIRCUMFERENCE} ${PIE_CIRCUMFERENCE}`} transform="rotate(-90 7 7)" />
      ) : null}
      {status === "blocked" ? (
        <path d="M3.2 10.8 10.8 3.2" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      ) : null}
    </svg>
  );
}
