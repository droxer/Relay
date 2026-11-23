import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { captureTranscriptAnchor, restoreTranscriptAnchor, sizeNewTurns, type TranscriptAnchor } from "../lib/transcriptAnchor";

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
 *
 * Away from the bottom, the same observer keeps the reader's place instead:
 * a turn above them that trades its placeholder height for its real one, or
 * a history page inserted above, would otherwise move what they are reading
 * (see `lib/transcriptAnchor.ts`).
 */
interface TranscriptPin {
  /** Attach to the scrolling transcript element. */
  ref: (node: HTMLDivElement | null) => void;
  /** Attach to that element's onScroll. */
  onScroll: () => void;
  /** Re-pin to the bottom — call after sending, or when opening a thread. */
  pinToBottom: () => void;
  /**
   * The reader's place away from the bottom: `hold` records it — call before
   * inserting turns above it; `keep` sizes newly mounted turns and undoes any
   * shift since — call at layout time whenever turns mount.
   */
  readingPosition: ReadingPosition;
}

export type ReadingPosition = { hold: () => void; keep: () => void };

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
  const lastPinnedTop = useRef<number | undefined>(undefined);
  const anchor = useRef<TranscriptAnchor | null>(null);

  const holdReadingPosition = useCallback(() => {
    const el = elementRef.current;
    anchor.current = el ? captureTranscriptAnchor(el) : null;
  }, []);

  const keepReadingPosition = useCallback(() => {
    const el = elementRef.current;
    if (!el) return;
    sizeNewTurns(el);
    if (!atBottom.current) anchor.current = restoreTranscriptAnchor(el, anchor.current);
  }, []);

  const onScroll = useCallback(() => {
    const el = elementRef.current;
    if (!el) return;
    const top = el.scrollTop;
    // More output can arrive before the scroll event from our last pin.
    // That event must not turn off following just because the bottom moved.
    if (atBottom.current && top === lastPinnedTop.current) return;
    lastPinnedTop.current = undefined;
    atBottom.current = el.scrollHeight - top - el.clientHeight < BOTTOM_EPSILON;
    if (atBottom.current) {
      anchor.current = null;
      return;
    }
    // WebKit can swap a placeholder for its real height in the very layout
    // this handler forces. Undo that against the last anchor before taking a
    // new one, or the shift is recorded as where the reader already was.
    restoreTranscriptAnchor(el, anchor.current);
    anchor.current = captureTranscriptAnchor(el);
  }, []);

  const pinToBottom = useCallback(() => {
    atBottom.current = true;
    const el = elementRef.current;
    if (el) {
      const previousTop = el.scrollTop;
      el.scrollTop = el.scrollHeight;
      const top = el.scrollTop;
      if (top !== previousTop) lastPinnedTop.current = top;
    }
  }, []);

  useEffect(() => {
    atBottom.current = true;
    anchor.current = null;
  }, [sessionId]);

  // The DOM node is written through the ref; `element` (its state twin) is in
  // the deps only so attaching a node re-runs the pin.
  useEffect(() => {
    if (atBottom.current) pinToBottom();
  }, [element, messageCount, pinToBottom, sessionId]);

  useEffect(() => {
    const el = element;
    const content = el?.firstElementChild;
    if (!el || !content || typeof ResizeObserver === "undefined") return;
    // Runs after layout and before paint, so a shift is undone unseen.
    const observer = new ResizeObserver(() => {
      if (atBottom.current) pinToBottom();
      else keepReadingPosition();
    });
    observer.observe(content);
    return () => observer.disconnect();
  }, [element, keepReadingPosition, pinToBottom]);

  const readingPosition = useMemo(
    () => ({ hold: holdReadingPosition, keep: keepReadingPosition }),
    [holdReadingPosition, keepReadingPosition],
  );

  return { ref, onScroll, pinToBottom, readingPosition };
}
