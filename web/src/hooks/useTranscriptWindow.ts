import { useCallback, useLayoutEffect, useRef, useState } from "react";
import {
  nextTranscriptWindow,
  TRANSCRIPT_PAGE_SIZE,
  transcriptVisibleAfter,
  transcriptWindowStart,
} from "../lib/transcriptWindow";

type WindowState = {
  sessionId: string | undefined;
  total: number;
  visible: number;
  eventStart: number;
  hasEvents: boolean;
};

const SETTLED_FRAMES = 2;
const MAX_SETTLE_FRAMES = 30;
const PREFETCH_SCROLL_TOP = 600;
const BOTTOM_SLACK = 24;

/** The oldest mounted turn, which sits just below the sentinel. A turn is
 *  `display: contents`, so the box to measure is its first child. */
function readingAnchor(sentinel: HTMLDivElement | null): Element | null {
  const turn = sentinel?.nextElementSibling ?? null;
  return turn?.firstElementChild ?? turn;
}

/**
 * Which slice of a transcript is mounted: the newest page on open, one more
 * page each time a sentinel above the oldest mounted turn nears the top of the
 * scroller. Growing inserts content ABOVE the reader, so the turn they were
 * reading is pinned: its offset is restored before the new turns paint, and
 * again on the frames after, while the inserted turns trade their
 * `content-visibility` placeholder height for their real one. A single
 * restore left the reader shoved down by however much those heights grew.
 */
export function useTranscriptWindow(
  sessionId: string | undefined,
  total: number,
  eventStart: number,
  hasEvents: boolean,
  loadEarlier?: (beforeInsert: () => void) => Promise<void>,
): {
  start: number;
  sentinelRef: (node: HTMLDivElement | null) => void;
  pinOldest: () => void;
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

  const scroller = useRef<HTMLElement | null>(null);
  const sentinel = useRef<HTMLDivElement | null>(null);
  const anchor = useRef<{ scroller: HTMLElement; element: Element; top: number } | null>(null);
  const pinOldest = useCallback(() => {
    const element = scroller.current;
    const reading = readingAnchor(sentinel.current);
    if (element && reading) anchor.current = { scroller: element, element: reading, top: reading.getBoundingClientRect().top };
  }, []);
  const grow = useCallback(() => {
    pinOldest();
    setState((previous) => ({ ...previous, visible: nextTranscriptWindow(previous.visible, previous.total) }));
  }, [pinOldest]);

  useLayoutEffect(() => {
    const pinned = anchor.current;
    if (!pinned) return;
    const element = pinned.scroller;
    anchor.current = null;
    const restore = () => {
      if (!pinned.element.isConnected) return 0;
      const drift = pinned.element.getBoundingClientRect().top - pinned.top;
      if (drift !== 0) element.scrollTop += drift;
      return drift;
    };
    restore();
    // Heights settle over the next frames; keep the turn pinned until two
    // frames in a row hold still, or the budget runs out.
    let frame = 0;
    let still = 0;
    let handle = requestAnimationFrame(function settle() {
      still = restore() === 0 ? still + 1 : 0;
      frame += 1;
      if (still < SETTLED_FRAMES && frame < MAX_SETTLE_FRAMES) handle = requestAnimationFrame(settle);
    });
    // A scroll the reader makes meanwhile is theirs: stop correcting.
    const release = () => cancelAnimationFrame(handle);
    element.addEventListener("wheel", release, { once: true, passive: true });
    element.addEventListener("touchstart", release, { once: true, passive: true });
    return () => {
      release();
      element.removeEventListener("wheel", release);
      element.removeEventListener("touchstart", release);
    };
  }, [current.visible, current.eventStart]);

  const start = transcriptWindowStart(current.total, current.visible);
  const hasLocalOlder = start > 0;
  const removeScrollListener = useRef<(() => void) | null>(null);
  const sentinelRef = useCallback((node: HTMLDivElement | null) => {
    removeScrollListener.current?.();
    removeScrollListener.current = null;
    sentinel.current = node;
    const element = node?.closest<HTMLElement>(".transcript") ?? null;
    scroller.current = element;
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
        void loadEarlier?.(pinOldest);
      }
    };
    // Initial hydration can expose the sentinel before the transcript pins to
    // the bottom. Only expand history as the reader scrolls upward.
    element.addEventListener("scroll", onScroll, { passive: true });
    removeScrollListener.current = () => element.removeEventListener("scroll", onScroll);
  }, [grow, hasLocalOlder, loadEarlier, pinOldest]);

  return { start, sentinelRef, pinOldest };
}
