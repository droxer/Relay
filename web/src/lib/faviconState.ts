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

/** The dark register of palette.css, as favicon.svg draws it (a tab strip
 *  has no theme to follow). `unlit` is a chevron at rest: present on the
 *  canvas, quieter than any ink tier. faviconState.test.ts pins canvas,
 *  action, and live to the shipped favicon. */
export const FAVICON_INK = {
  canvas: "#0a0a0a",
  action: "#ff8a3d",
  live: "#6aa6ff",
  unlit: "#525252",
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
    + `<rect x="4" y="4" width="56" height="56" rx="15" fill="${FAVICON_INK.canvas}"/>`
    + `<g fill="none" stroke-width="6.5" stroke-linecap="round" stroke-linejoin="round">`
    + `<path d="M22 20 L36 32 L22 44" stroke="${lead}"/>`
    + `<path d="M36 20 L50 32 L36 44" stroke="${trail}"/>`
    + `</g></svg>`;
}

export function faviconDataUri(state: FaviconState): string {
  return `data:image/svg+xml,${encodeURIComponent(faviconSvg(state))}`;
}
