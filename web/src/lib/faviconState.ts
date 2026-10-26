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

/** Which register the tab's mark draws in: the theme the app is painted in. */
export type FaviconTheme = "dark" | "light";

/** Each register of palette.css, as favicon.svg draws it: the canvas
 *  (surface-0), the lead chevron (brand-lead), the trail (live), and the
 *  light badge's hairline (line-1; a white badge on a white tab strip needs
 *  an edge). `unlit` is a chevron at rest: present on the canvas, quieter
 *  than any ink tier, at the same ~2.7:1 in both registers.
 *  faviconState.test.ts pins these to the shipped favicon. */
export const FAVICON_INK = {
  dark: { canvas: "#000000", edge: null, action: "#ff8a3d", live: "#6aa6ff", unlit: "#525252" },
  light: { canvas: "#ffffff", edge: "#d9d9d9", action: "#b84400", live: "#2457c5", unlit: "#9e9e9e" },
} as const;

export function faviconState(items: readonly ThreadItem[], tasks: ThreadWaitSource = []): FaviconState {
  const groups = groupThreads(items, tasks);
  if (groups.needsYou.length > 0) return "waiting";
  return groups.running.length > 0 ? "running" : "idle";
}

/** favicon.svg's geometry with only the acting half lit. */
export function faviconSvg(state: FaviconState, theme: FaviconTheme = "dark"): string {
  const ink = FAVICON_INK[theme];
  const lead = state === "waiting" ? ink.action : ink.unlit;
  const trail = state === "running" ? ink.live : ink.unlit;
  const edge = ink.edge ? ` stroke="${ink.edge}" stroke-width="1"` : "";
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">`
    + `<rect x="4" y="4" width="56" height="56" rx="15" fill="${ink.canvas}"${edge}/>`
    + `<g fill="none" stroke-width="6.5" stroke-linecap="round" stroke-linejoin="round">`
    + `<path d="M18 19.4 L32 32 L18 44.6" stroke="${lead}"/>`
    + `<path d="M32 19.4 L46 32 L32 44.6" stroke="${trail}"/>`
    + `</g></svg>`;
}

export function faviconDataUri(state: FaviconState, theme: FaviconTheme = "dark"): string {
  return `data:image/svg+xml,${encodeURIComponent(faviconSvg(state, theme))}`;
}
