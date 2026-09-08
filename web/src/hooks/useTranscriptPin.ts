import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Keeps the transcript pinned to its newest output while the reader is at the
 * bottom, and lets go the moment they scroll up.
 *
 * The two effects are not redundant. The first fires when a block is ADDED or
 * the session changes. A single agent turn streaming a long response grows one
 * block's height without changing the count, so in a thread tall enough to
 * overflow, the new output scrolls below the fold and the view appears to
 * freeze at the start of the response — the second effect observes the content
 * box and re-pins on height change to cover exactly that.
 *
 * `atBottom` is a ref rather than state on purpose: it is read inside a scroll
 * handler and a ResizeObserver on every frame, and it must never itself cause
 * a render.
 */
export interface TranscriptPin {
  /** Attach to the scrolling transcript element. */
  ref: (node: HTMLDivElement | null) => void;
  /** Attach to that element's onScroll. */
  onScroll: () => void;
  /** Re-pin to the bottom — call after sending, or when opening a thread. */
  pinToBottom: () => void;
}

/** Slack for "at the bottom", in px: a rounding error must not unpin the view. */
const BOTTOM_EPSILON = 24;

export function useTranscriptPin(
  messageCount: number,
  sessionId: string | undefined,
): TranscriptPin {
  const elementRef = useRef<HTMLDivElement | null>(null);
  const [element, setElement] = useState<HTMLDivElement | null>(null);
  const ref = useCallback((node: HTMLDivElement | null) => {
    elementRef.current = node;
    setElement(node);
  }, []);
  const atBottom = useRef(true);

  const onScroll = useCallback(() => {
    const el = elementRef.current;
    if (el) atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < BOTTOM_EPSILON;
  }, []);

  const pinToBottom = useCallback(() => {
    atBottom.current = true;
    const el = elementRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, []);

  useEffect(() => { atBottom.current = true; }, [sessionId]);

  useEffect(() => {
    const el = element;
    if (el && atBottom.current) el.scrollTop = el.scrollHeight;
  }, [element, messageCount, sessionId]);

  useEffect(() => {
    const el = element;
    const content = el?.firstElementChild;
    if (!el || !content || typeof ResizeObserver === "undefined") return;
    let frame: number | undefined;
    const observer = new ResizeObserver(() => {
      if (!atBottom.current || frame !== undefined) return;
      frame = window.requestAnimationFrame(() => {
        frame = undefined;
        if (atBottom.current) el.scrollTop = el.scrollHeight;
      });
    });
    observer.observe(content);
    return () => {
      observer.disconnect();
      if (frame !== undefined) window.cancelAnimationFrame(frame);
    };
  }, [element]);

  return { ref, onScroll, pinToBottom };
}
