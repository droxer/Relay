import { useCallback, useLayoutEffect, useRef, useState } from "react";
import {
  nextTranscriptWindow,
  TRANSCRIPT_PAGE_SIZE,
  transcriptVisibleAfter,
  transcriptWindowStart,
} from "../lib/transcriptWindow";
import type { ReadingPosition } from "./useTranscriptPin";

type WindowState = {
  sessionId: string | undefined;
  total: number;
  visible: number;
  eventStart: number;
  hasEvents: boolean;
};

const PREFETCH_SCROLL_TOP = 600;
const BOTTOM_SLACK = 24;

/**
 * Which slice of a transcript is mounted: the newest page on open, one more
 * page each time a sentinel above the oldest mounted turn nears the top of the
 * scroller. Growing inserts content ABOVE the reader, so the reading position
 * is recorded first; the transcript's anchor (`useTranscriptPin`) then undoes
 * the shift before it paints, and keeps undoing it while the inserted turns
 * trade their `content-visibility` placeholder height for their real one.
 */
export function useTranscriptWindow(
  sessionId: string | undefined,
  total: number,
  eventStart: number,
  hasEvents: boolean,
  readingPosition: ReadingPosition,
  loadEarlier?: (beforeInsert: () => void) => Promise<void>,
): {
  start: number;
  sentinelRef: (node: HTMLDivElement | null) => void;
} {
  const [state, setState] = useState<WindowState>({ sessionId, total, visible: TRANSCRIPT_PAGE_SIZE, eventStart, hasEvents });

  // Derived from props during render, not in an effect: an effect would
  // mount the whole transcript for one frame before cutting it back.
  let current = state;
  if (state.sessionId !== sessionId || state.hasEvents !== hasEvents) {
    current = { sessionId, total, visible: TRANSCRIPT_PAGE_SIZE, eventStart, hasEvents };
  } else if (state.total !== total || state.eventStart !== eventStart) {
    const visible = eventStart < state.eventStart
      ? total : transcriptVisibleAfter(state.total, state.visible, total);
    current = { sessionId, total, visible, eventStart, hasEvents };
  }
  if (current !== state) setState(current);

  const { hold: holdReadingPosition, keep: keepReadingPosition } = readingPosition;
  const grow = useCallback(() => {
    holdReadingPosition();
    setState((previous) => ({ ...previous, visible: nextTranscriptWindow(previous.visible, previous.total) }));
  }, [holdReadingPosition]);
  // Whenever turns mount — on open, a page above, or new output — size them
  // and correct before anything (paint or a script reading layout) sees them.
  useLayoutEffect(keepReadingPosition, [current.sessionId, current.total, current.visible, current.eventStart, keepReadingPosition]);

  const start = transcriptWindowStart(current.total, current.visible);
  const hasLocalOlder = start > 0;
  const removeScrollListener = useRef<(() => void) | null>(null);
  const sentinelRef = useCallback((node: HTMLDivElement | null) => {
    removeScrollListener.current?.();
    removeScrollListener.current = null;
    const element = node?.closest<HTMLElement>(".transcript") ?? null;
    if (!element || (!hasLocalOlder && !loadEarlier)) return;
    let previousTop = element.scrollTop;
    const onScroll = () => {
      const top = element.scrollTop;
      const approachingOlderTurns = top < previousTop && top <= PREFETCH_SCROLL_TOP;
      previousTop = top;
      if (!approachingOlderTurns) return;
      if (hasLocalOlder) {
        grow();
      } else if (element.scrollHeight - element.clientHeight - top > BOTTOM_SLACK) {
        void loadEarlier?.(holdReadingPosition);
      }
    };
    // Initial hydration can expose the sentinel before the transcript pins to
    // the bottom. Only expand history as the reader scrolls upward.
    element.addEventListener("scroll", onScroll, { passive: true });
    removeScrollListener.current = () => element.removeEventListener("scroll", onScroll);
  }, [grow, hasLocalOlder, holdReadingPosition, loadEarlier]);

  return { start, sentinelRef };
}
