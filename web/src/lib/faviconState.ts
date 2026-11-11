import { groupThreads } from "./threadGroups.ts";
import type { ThreadItem } from "./threads.js";
import type { ThreadWaitSource } from "./awaitingInput.ts";

/**
 * What the browser tab's mark says while Relay sits in the background.
 *
 * The favicon is the handoff mark: a person's orange chevron leading an
 * agent's blue one. At rest both halves keep their brand colors. While an
 * agent works, only its blue half stays colored; when a person is needed,
 * only the orange half does.
 * A person outranks a run, the same order as the rail's "needs you" group.
 */
export type FaviconState = "idle" | "running" | "waiting";

/** Fixed tab colors: the browser chrome can differ from the app's theme.
 * Bright orange and blue stay visible at 16px on a charcoal tile with a
 * subtle hairline.
 * The colored half identifies activity. Keep the static favicon in sync. */
export const FAVICON_INK = {
  canvas: "#171d22",
  outline: "#52606b",
  action: "#ff8a3d",
  live: "#91b9f2",
  unlit: "#f1f5f9",
} as const;

/** favicon.svg's geometry: a full-bleed tile and two bold chevrons, sized so
 *  each stroke is 3px and the gap between them stays over 1px at 16px. */
export const FAVICON_PATHS = {
  lead: "M10 12 L30 32 L10 52",
  trail: "M34 12 L54 32 L34 52",
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
    + `<g fill="none" stroke-width="12" stroke-linecap="round" stroke-linejoin="round">`
    + `<path d="${FAVICON_PATHS.lead}" stroke="${lead}"/>`
    + `<path d="${FAVICON_PATHS.trail}" stroke="${trail}"/>`
    + `</g></svg>`;
}

export function faviconDataUri(state: FaviconState): string {
  return `data:image/svg+xml,${encodeURIComponent(faviconSvg(state))}`;
}
