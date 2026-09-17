import { useCallback, useLayoutEffect, useRef, useState } from "react";
import {
  nextTranscriptWindow,
  TRANSCRIPT_PAGE_SIZE,
  transcriptVisibleAfter,
  transcriptWindowStart,
} from "../lib/transcriptWindow";

type WindowState = { sessionId: string | undefined; total: number; visible: number };

/**
 * Which slice of a transcript is mounted: the newest page on open, one more
 * page each time a sentinel above the oldest mounted turn nears the top of the
 * scroller. Growing inserts content ABOVE the reader, so the scroll offset is
 * restored from the distance to the bottom before the new turns paint — the
 * turn they were reading stays exactly where it was.
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
  const distanceFromBottom = useRef<number | null>(null);
  const grow = useCallback(() => {
    const element = scroller.current;
    if (element) distanceFromBottom.current = element.scrollHeight - element.scrollTop;
    setState((previous) => ({ ...previous, visible: nextTranscriptWindow(previous.visible, previous.total) }));
  }, []);

  useLayoutEffect(() => {
    const element = scroller.current;
    const distance = distanceFromBottom.current;
    if (!element || distance === null) return;
    distanceFromBottom.current = null;
    element.scrollTop = element.scrollHeight - distance;
  }, [current.visible]);

  const observer = useRef<IntersectionObserver | null>(null);
  const sentinelRef = useCallback((node: HTMLDivElement | null) => {
    observer.current?.disconnect();
    observer.current = null;
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
