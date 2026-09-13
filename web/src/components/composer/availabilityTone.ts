import type { StateTone } from "../StateMark";

/**
 * Availability → pip tone, shared by every agent picker in the composer (the
 * target picker and the handoff panel), so the two cannot drift into different
 * hues for the same word.
 *
 * `ready` and `busy` both stay neutral: this pip always sits beside the
 * availability word, so hue only has to separate the states the label cannot
 * make urgent on its own. `offline`/`inactive` resolve to `bad`, which
 * StateMark draws as the hollow ring.
 */
const PIP_TONE: Record<string, StateTone> = {
  pending: "warn",
  offline: "bad",
  inactive: "bad",
};

export const availabilityPipTone = (availability: string): StateTone =>
  PIP_TONE[availability] ?? "neutral";
