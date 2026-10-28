import { groupThreads } from "./threadGroups.ts";
import type { ThreadItem } from "./threads.js";
import type { ThreadWaitSource } from "./awaitingInput.ts";

/**
 * What the browser tab's mark says while Relay sits in the background.
 *
 * The favicon is the handoff mark: a person's orange chevron leading an
 * agent's blue one. At rest both halves go dark; while an agent works only
 * its blue half lights; when a person is needed only the orange half does.
 * A person outranks a run, the same order as the rail's "needs you" group.
 */
export type FaviconState = "idle" | "running" | "waiting";

/** The tab's ink. One register whatever the app's theme: the app cannot see
 *  the browser's tab strip, and a badge matched to the app's theme vanished
 *  into a strip of the same tone (a white badge on a light strip, a black
 *  one on a dark strip). A black tile carries the mark on both, as the
 *  chevrons do the reading. `canvas` is the dark surface-0, `action` the
 *  brand lead, `live` the dark live blue; `unlit` is a chevron at rest —
 *  quieter than either lit hue but ~6:1 on the tile, so an idle tab still
 *  shows the mark at 16px. faviconState.test.ts pins these to favicon.svg. */
export const FAVICON_INK = {
  canvas: "#000000",
  action: "#ff8a3d",
  live: "#6aa6ff",
  unlit: "#8f8f8f",
} as const;

/** favicon.svg's geometry: a full-bleed tile and two bold chevrons, sized so
 *  each stroke is ~2px and the gap between them ~1px at 16px. */
export const FAVICON_PATHS = {
  lead: "M15 16 L31 32 L15 48",
  trail: "M33 16 L49 32 L33 48",
} as const;

export function faviconState(items: readonly ThreadItem[], tasks: ThreadWaitSource = []): FaviconState {
  const groups = groupThreads(items, tasks);
  if (groups.needsYou.length > 0) return "waiting";
  return groups.running.length > 0 ? "running" : "idle";
}

/** favicon.svg's geometry with only the acting half lit. */
export function faviconSvg(state: FaviconState): string {
  const lead = state === "waiting" ? FAVICON_INK.action : FAVICON_INK.unlit;
  const trail = state === "running" ? FAVICON_INK.live : FAVICON_INK.unlit;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">`
    + `<rect width="64" height="64" rx="14" fill="${FAVICON_INK.canvas}"/>`
    + `<g fill="none" stroke-width="8" stroke-linecap="round" stroke-linejoin="round">`
    + `<path d="${FAVICON_PATHS.lead}" stroke="${lead}"/>`
    + `<path d="${FAVICON_PATHS.trail}" stroke="${trail}"/>`
    + `</g></svg>`;
}

export function faviconDataUri(state: FaviconState): string {
  return `data:image/svg+xml,${encodeURIComponent(faviconSvg(state))}`;
}
