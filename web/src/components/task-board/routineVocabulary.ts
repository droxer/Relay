import type { RoutineState } from "../../lib/routine";
import type { StateShape } from "../StateMark";

/**
 * The routine board's shared vocabulary — the piece the rail, the rows and
 * the detail pane all have to agree on. Mirrors `backlogVocabulary.ts`, and
 * lives apart from any of them for the same reason: a component that renders
 * a routine must not import it from another component that renders one.
 *
 * Schedule health in the shared shape vocabulary (see StateMark). Shape does
 * the separating work: a paused routine is muted, a missing next-run date is
 * dashed, an overdue one is a hollow ring, and a live occurrence is the one
 * place a routine surface earns `--live`.
 *
 * There is no badge beside this map any more. `scheduled` — the resting state
 * of a healthy routine — rendered nothing on a scanning surface, and every
 * other state now reads as this mark plus an sr-only word on the row, or as a
 * plain fact in the detail pane's RecordBand. A pill would be the third
 * grammar for one dimension.
 */
export const ROUTINE_STATE_SHAPE: Record<RoutineState, StateShape> = {
  running: "live",
  overdue: "ring",
  due: "solid",
  scheduled: "solid",
  unscheduled: "dashed",
  paused: "muted",
};
