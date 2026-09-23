import { cn } from "@/lib/utils";
import type { Tone } from "../types";

/**
 * The shape half of Relay's state vocabulary.
 *
 * Five or six states cannot be separated by colour alone even now that the
 * status tones carry hue: at a 10px mark, a green and an amber dot are two
 * dots. Colour therefore carries the *tone* (good → bad) and shape carries
 * the *class*:
 *
 * - `solid`  — on track, nothing to say
 * - `live`   — an agent is working right now (the only `--live` surface here)
 * - `ring`   — a problem: blocked, overdue, failed
 * - `dashed` — nothing set: unscheduled, unassigned
 * - `muted`  — out of play: paused, done
 *
 * The accent comes from `--mark-accent`, which the host rule sets — the mark
 * never picks its own colour, so a row rail and its label always agree.
 */
export type StateShape = "solid" | "live" | "ring" | "dashed" | "muted";

/**
 * The tone vocabulary a standalone pip speaks, plus `live` for work in
 * flight. Both halves come from the `.tone-*` driver in tokens/base.css,
 * which is the only place the tone → hue mapping is written down.
 */
export type StateTone = Tone | "live";

/**
 * Tone → shape, and the reason this component exists in this form.
 *
 * Eight surfaces used to draw their own 8px status circle — five different
 * tone-plumbing conventions between them — and five of the eight filled
 * `bad` solid, which the grammar forbids: at this size a solid `--err` reads
 * as emphasis, not as a problem, so the ring is what says "bad". One of them
 * inverted the vocabulary outright and spent the ring on *settled*, so the
 * same shape meant opposite things on two adjacent surfaces.
 *
 * Deriving the shape here is the fix. A caller that knows its tone cannot
 * forget the shape, and there is one place to change the rule.
 */
const SHAPE_FOR_TONE: Record<StateTone, StateShape> = {
  live: "live",
  bad: "ring",
  good: "solid",
  warn: "solid",
  info: "solid",
  neutral: "solid",
};

/**
 * The shape a filter row should draw for `count` records.
 *
 * `live` is the one shape that makes a claim about the present moment, and it
 * is the only place `--live` is allowed — a purple mark means an agent is
 * working right now, and it pulses to say so. On a section rail the mark sits
 * beside a count, so "Running 0" was drawing a static purple dot next to a
 * zero: a liveness surface asserting liveness that is not there. An empty
 * bucket rests instead.
 */
export function shapeForCount(shape: StateShape, count: number): StateShape {
  return shape === "live" && count === 0 ? "solid" : shape;
}

export function StateMark({
  shape,
  tone,
  className,
}: {
  /** Override the shape the tone implies — e.g. a settled row is `muted`. */
  shape?: StateShape;
  /** Emits the canonical `.tone-*` class; the CSS reads `--tone` from it. */
  tone?: StateTone;
  className?: string;
}) {
  const resolved = shape ?? (tone ? SHAPE_FOR_TONE[tone] : "solid");
  return (
    <span
      aria-hidden="true"
      className={cn("state-mark", tone && `tone-${tone}`, className)}
      data-shape={resolved}
      data-tone={tone}
    />
  );
}
