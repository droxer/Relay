import { useCallback, useLayoutEffect, useRef, useState } from "react";
import {
  nextTranscriptWindow,
  TRANSCRIPT_PAGE_SIZE,
  transcriptVisibleAfter,
  transcriptWindowStart,
} from "../lib/transcriptWindow";

type WindowState = { sessionId: string | undefined; total: number; visible: number };

const SETTLED_FRAMES = 2;
const MAX_SETTLE_FRAMES = 30;

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
export function useTranscriptWindow(sessionId: string | undefined, total: number): {
  start: number;
  sentinelRef: (node: HTMLDivElement | null) => void;
} {
  const [state, setState] = useState<WindowState>({ sessionId, total, visible: TRANSCRIPT_PAGE_SIZE });

  // Derived from props during render, not in an effect: an effect would
  // mount the whole transcript for one frame before cutting it back.
  let current = state;
  if (state.sessionId !== sessionId) {
    current = { sessionId, total, visible: TRANSCRIPT_PAGE_SIZE };
  } else if (state.total !== total) {
    current = { sessionId, total, visible: transcriptVisibleAfter(state.total, state.visible, total) };
  }
  if (current !== state) setState(current);

  const scroller = useRef<HTMLElement | null>(null);
  const sentinel = useRef<HTMLDivElement | null>(null);
  const anchor = useRef<{ element: Element; top: number } | null>(null);
  const grow = useCallback(() => {
    const element = scroller.current;
    const reading = readingAnchor(sentinel.current);
    if (element && reading) anchor.current = { element: reading, top: reading.getBoundingClientRect().top };
    setState((previous) => ({ ...previous, visible: nextTranscriptWindow(previous.visible, previous.total) }));
  }, []);

  useLayoutEffect(() => {
    const element = scroller.current;
    const pinned = anchor.current;
    if (!element || !pinned) return;
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
  }, [current.visible]);

  const observer = useRef<IntersectionObserver | null>(null);
  const sentinelRef = useCallback((node: HTMLDivElement | null) => {
    observer.current?.disconnect();
    observer.current = null;
    sentinel.current = node;
    if (!node || typeof IntersectionObserver === "undefined") return;
    scroller.current = node.closest<HTMLElement>(".transcript");
    observer.current = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) grow();
      },
      // Load a screen early so scrolling up rarely meets the edge.
      { root: scroller.current, rootMargin: "600px 0px 0px 0px" },
    );
    observer.current.observe(node);
  }, [grow]);

  return { start: transcriptWindowStart(current.total, current.visible), sentinelRef };
}
