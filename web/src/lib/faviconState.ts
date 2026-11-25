import { groupThreads } from "./threadGroups.ts";
import type { ThreadItem } from "./threads.js";
import type { ThreadWaitSource } from "./awaitingInput.ts";

/**
 * What the browser tab's mark says while Relay sits in the background.
 *
 * The favicon is the Swiss Baton Cascade: three precision sheared tracks
 * (person above, relay baton in the center, agent execution below). At rest
 * the outer tracks are crisp ink and the center baton is burnished bronze.
 * When a person is needed, the upper track and baton light up bronze; while
 * an agent works, the baton and lower track light up signal blue. A person
 * outranks a run, matching the rail's "needs you" group.
 */
export type FaviconState = "idle" | "running" | "waiting";

/** Fixed tab colors: the browser chrome can differ from the app's theme.
 * Monochrome ink, burnished bronze, and signal blue stay crisp at 16px on a
 * lunar charcoal tile with a whisper hairline. Keep favicon.svg in sync. */
export const FAVICON_INK = {
  canvas: "#111111",
  outline: "#2e2e2c",
  action: "#c8966e",
  live: "#82b4f5",
  unlit: "#f2f2f0",
} as const;

/** favicon.svg's geometry: three precision sheared tracks on a 64x64 grid. */
export const FAVICON_PATHS = {
  top: "M14 12 H48 L43 22 H9 Z",
  baton: "M21 27 H55 L50 37 H16 Z",
  bottom: "M14 42 H48 L43 52 H9 Z",
} as const;

export function faviconState(items: readonly ThreadItem[], tasks: ThreadWaitSource = []): FaviconState {
  const groups = groupThreads(items, tasks);
  if (groups.needsYou.length > 0) return "waiting";
  return groups.running.length > 0 ? "running" : "idle";
}

/** At rest, monochrome rails flank the bronze baton; active states light the acting side. */
export function faviconSvg(state: FaviconState): string {
  const top = state === "waiting" ? FAVICON_INK.action : FAVICON_INK.unlit;
  const baton = state === "running" ? FAVICON_INK.live : FAVICON_INK.action;
  const bottom = state === "running" ? FAVICON_INK.live : FAVICON_INK.unlit;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">`
    + `<rect x="0.5" y="0.5" width="63" height="63" rx="13.5" fill="${FAVICON_INK.canvas}" stroke="${FAVICON_INK.outline}" stroke-width="1"/>`
    + `<g transform="translate(32 32) scale(0.84) translate(-32 -32)">`
    + `<path d="${FAVICON_PATHS.top}" fill="${top}"/>`
    + `<path d="${FAVICON_PATHS.baton}" fill="${baton}"/>`
    + `<path d="${FAVICON_PATHS.bottom}" fill="${bottom}"/>`
    + `</g></svg>`;
}

export function faviconDataUri(state: FaviconState): string {
  return `data:image/svg+xml,${encodeURIComponent(faviconSvg(state))}`;
}
