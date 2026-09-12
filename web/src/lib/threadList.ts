import { TRANSCRIPT_MIN_WIDTH } from "./threadSpace.ts";

export const THREAD_LIST_WIDTH_DEFAULT = 318;
export const THREAD_LIST_WIDTH_MIN = 240;
export const THREAD_LIST_WIDTH_MAX = 480;

/** How wide the thread list may grow right now: whatever the chat column can
 *  give up before hitting its floor, capped by the absolute maximum. Mirrors
 *  maxSpaceWidth in threadSpace.ts — measure both widths once at gesture
 *  start so the ceiling doesn't drift as the grid re-lays out mid-drag. */
export function maxThreadListWidth(currentWidth: number, chatWidth: number | null): number {
  if (chatWidth === null || !Number.isFinite(chatWidth)) return THREAD_LIST_WIDTH_MAX;
  const room = currentWidth + (chatWidth - TRANSCRIPT_MIN_WIDTH);
  return Math.min(THREAD_LIST_WIDTH_MAX, Math.max(THREAD_LIST_WIDTH_MIN, Math.round(room)));
}

export function clampThreadListWidth(width: number, max: number = THREAD_LIST_WIDTH_MAX): number {
  if (typeof width !== "number" || Number.isNaN(width)) return THREAD_LIST_WIDTH_DEFAULT;
  const ceiling = Math.min(THREAD_LIST_WIDTH_MAX, Math.max(THREAD_LIST_WIDTH_MIN, max));
  return Math.min(ceiling, Math.max(THREAD_LIST_WIDTH_MIN, Math.round(width)));
}
