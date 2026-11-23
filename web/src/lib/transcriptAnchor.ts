/**
 * Scroll anchoring for the transcript, done by hand.
 *
 * Turns render with `content-visibility: auto`, so a turn the reader has not
 * reached yet holds a placeholder height and trades it for its real one as it
 * nears the viewport. When that happens above the reader, everything they are
 * looking at moves. Chromium's native scroll anchoring hides it; WebKit's
 * does not, and on a phone each placeholder swap reads as a jump. The
 * transcript therefore turns native anchoring off (`overflow-anchor: none`)
 * and anchors itself through these helpers, the same way in every engine.
 *
 * The anchor is the first turn that starts inside the viewport — not the one
 * straddling its top edge, because WebKit renders a placeholder turn only as
 * it enters the viewport, so the straddling turn is the one that changes
 * height, and anchoring on it would let it push everything below. It is
 * recorded by its offset in the
 * scroll content rather than in the viewport: that offset changes only when
 * something above the turn changes height, never because the reader scrolled.
 * A correction therefore undoes layout shifts and cannot fight a fling, a
 * drag, or momentum still carrying the view.
 */

export type TranscriptAnchor = { element: Element; offset: number };

/** Marks a turn that has been laid out at its real size once. */
const SIZED_ATTRIBUTE = "data-sized";

const TURN_SELECTOR = ".msg";
/** Sub-pixel layout noise is not a shift worth a scroll write. */
const MIN_SHIFT = 0.5;

function contentOffset(scroller: HTMLElement, element: Element): number {
  return element.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop;
}

/** Index of the first turn whose top edge is at or below `top`, or -1. */
function firstTurnStartingBelow(turns: NodeListOf<Element>, top: number): number {
  let low = 0;
  let high = turns.length - 1;
  let found = -1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    if (turns[middle].getBoundingClientRect().top >= top) {
      found = middle;
      high = middle - 1;
    } else {
      low = middle + 1;
    }
  }
  return found;
}

/**
 * The first turn starting inside the viewport; when a single turn fills the
 * whole viewport, that turn.
 */
export function captureTranscriptAnchor(scroller: HTMLElement): TranscriptAnchor | null {
  const turns = scroller.querySelectorAll(TURN_SELECTOR);
  if (turns.length === 0) return null;
  const box = scroller.getBoundingClientRect();
  const next = firstTurnStartingBelow(turns, box.top);
  const inView = next >= 0 && turns[next].getBoundingClientRect().top < box.bottom;
  const index = inView ? next : (next < 0 ? turns.length : next) - 1;
  if (index < 0) return null;
  const element = turns[index];
  return { element, offset: contentOffset(scroller, element) };
}

/**
 * Scrolls by however far layout above the anchor moved it, and returns the
 * anchor at its new offset (or a fresh one when it left the DOM).
 */
export function restoreTranscriptAnchor(scroller: HTMLElement, anchor: TranscriptAnchor | null): TranscriptAnchor | null {
  if (!anchor || !anchor.element.isConnected) return captureTranscriptAnchor(scroller);
  const offset = contentOffset(scroller, anchor.element);
  const shift = offset - anchor.offset;
  if (Math.abs(shift) >= MIN_SHIFT) scroller.scrollTop += shift;
  return { element: anchor.element, offset };
}

/**
 * Lays out every turn mounted since the last call at its real size, once.
 *
 * `contain-intrinsic-size: auto` remembers a turn's real height only after the
 * turn has been laid out; until then it is a 160px placeholder, and the swap
 * to the real height happens when the turn reaches the viewport — in WebKit,
 * in the frame it is painted, too late for any scroll correction. Laying new
 * turns out for one frame records their real heights, so the later skip and
 * re-render never change a height at all. Call at layout time, before the
 * new turns paint; the inserted heights are then real for the anchor too.
 */
export function sizeNewTurns(scroller: HTMLElement): void {
  const fresh = [...scroller.querySelectorAll<HTMLElement>(`${TURN_SELECTOR}:not([${SIZED_ATTRIBUTE}])`)];
  if (fresh.length === 0) return;
  for (const turn of fresh) {
    turn.setAttribute(SIZED_ATTRIBUTE, "");
    turn.style.contentVisibility = "visible";
  }
  // The heights are remembered when the frame that lays the turns out is
  // rendered; hand the turns back to `content-visibility` after it.
  requestAnimationFrame(() => requestAnimationFrame(() => {
    for (const turn of fresh) turn.style.removeProperty("content-visibility");
  }));
}
