import { TRANSCRIPT_MIN_WIDTH, viewportCeiling } from "./threadSpace.ts";

export const THREAD_LIST_WIDTH_DEFAULT = 318;
export const THREAD_LIST_WIDTH_MIN = 240;
export const THREAD_LIST_WIDTH_MAX = 480;
/** The share of the viewport this column's preferred width is capped to —
 *  the `Nvw` half of `--thread-w-fit` in tokens/palette.css, which is what the
 *  shell grid actually asks for. CSS caps the RENDERED width; this constant is
 *  how the drag ceiling agrees with it, so the handle cannot run past a rail
 *  that is not following. shellColumns.test.ts fails if either side moves
 *  alone, exactly as it does for the floors. */
export const THREAD_LIST_VIEWPORT_SHARE = 0.26;

/** How wide the thread list may grow right now: whatever the chat column can
 *  give up before hitting its floor, capped by the absolute maximum and by the
 *  share of `viewportWidth` the shell track will actually render. Mirrors
 *  maxSpaceWidth in threadSpace.ts — measure every width once at gesture start
 *  so the ceiling doesn't drift as the grid re-lays out mid-drag. */
export function maxThreadListWidth(
  currentWidth: number,
  chatWidth: number | null,
  viewportWidth: number | null = null,
): number {
  const ceiling = viewportCeiling(THREAD_LIST_WIDTH_MAX, THREAD_LIST_VIEWPORT_SHARE, viewportWidth);
  if (chatWidth === null || !Number.isFinite(chatWidth)) return Math.max(THREAD_LIST_WIDTH_MIN, ceiling);
  const room = currentWidth + (chatWidth - TRANSCRIPT_MIN_WIDTH);
  return Math.max(THREAD_LIST_WIDTH_MIN, Math.min(ceiling, Math.round(room)));
}

export function clampThreadListWidth(width: number, max: number = THREAD_LIST_WIDTH_MAX): number {
  if (typeof width !== "number" || Number.isNaN(width)) return THREAD_LIST_WIDTH_DEFAULT;
  const ceiling = Math.min(THREAD_LIST_WIDTH_MAX, Math.max(THREAD_LIST_WIDTH_MIN, max));
  return Math.min(ceiling, Math.max(THREAD_LIST_WIDTH_MIN, Math.round(width)));
}
