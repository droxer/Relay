import { groupThreads } from "./threadGroups.ts";
import type { ThreadItem } from "./threads.js";
import type { ThreadWaitSource } from "./awaitingInput.ts";

/**
 * What the browser tab's mark says while Relay sits in the background.
 *
 * The favicon is the interlocking baton-handoff mark: a person's burnished
 * bronze lead track handing off to an agent's signal-blue trailing track. At
 * rest both halves keep their brand colors. While an agent works, only its
 * blue half stays colored; when a person is needed, only the bronze half does.
 * A person outranks a run, the same order as the rail's "needs you" group.
 */
export type FaviconState = "idle" | "running" | "waiting";

/** Fixed tab colors: the browser chrome can differ from the app's theme.
 * Burnished bronze and signal blue stay crisp at 16px on a lunar charcoal tile
 * with a whisper hairline. Keep the static favicon in sync. */
export const FAVICON_INK = {
  canvas: "#111111",
  outline: "#2e2e2c",
  action: "#c8966e",
  live: "#82b4f5",
  unlit: "#f2f2f0",
} as const;

/** favicon.svg's geometry: two bold 45-degree chamfered relay tracks exchanging
 *  a diagonal negative-space baton across the center of the 64x64 tile. */
export const FAVICON_PATHS = {
  lead: "M8 12 H36 L50 26 L42 34 L31 23 H8 Z",
  trail: "M56 52 H28 L14 38 L22 30 L33 41 H56 Z",
} as const;

export function faviconState(items: readonly ThreadItem[], tasks: ThreadWaitSource = []): FaviconState {
  const groups = groupThreads(items, tasks);
  if (groups.needsYou.length > 0) return "waiting";
  return groups.running.length > 0 ? "running" : "idle";
}

/** Keep the idle brand mark colorful; active states emphasize the acting half. */
export function faviconSvg(state: FaviconState): string {
  const lead = state === "running" ? FAVICON_INK.unlit : FAVICON_INK.action;
  const trail = state === "waiting" ? FAVICON_INK.unlit : FAVICON_INK.live;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">`
    + `<rect x="0.5" y="0.5" width="63" height="63" rx="13.5" fill="${FAVICON_INK.canvas}" stroke="${FAVICON_INK.outline}" stroke-width="1"/>`
    + `<g transform="translate(32 32) scale(0.84) translate(-32 -32)">`
    + `<path d="${FAVICON_PATHS.lead}" fill="${lead}"/>`
    + `<path d="${FAVICON_PATHS.trail}" fill="${trail}"/>`
    + `</g></svg>`;
}

export function faviconDataUri(state: FaviconState): string {
  return `data:image/svg+xml,${encodeURIComponent(faviconSvg(state))}`;
}
