"use client";

import { useRef, useState, type PointerEvent } from "react";

/** How far a sheet must be dragged down before letting go dismisses it.
 *  Shorter drags spring back, as a native sheet does. */
export const DISMISS_DRAG_PX = 80;

/** Movement under this is a tap, not a drag: the sheet does not move. */
const DRAG_SLOP_PX = 6;

/** A press that starts on a control belongs to the control, not the gesture,
 *  so the pointer is captured only on the strip's bare surface. Captured at
 *  once, not after the slop: a quick flick's first move can already be past
 *  the strip, and an uncaptured move there never reaches it. */
const INTERACTIVE = "button, a[href], input, textarea, select, [role='button'], [role='tab']";

export type SheetDragHandlers = {
  onPointerDown: (event: PointerEvent<HTMLElement>) => void;
  onPointerMove: (event: PointerEvent<HTMLElement>) => void;
  onPointerUp: (event: PointerEvent<HTMLElement>) => void;
  onPointerCancel: (event: PointerEvent<HTMLElement>) => void;
};

/**
 * Drag-down-to-dismiss for a sheet, bound to the strip the finger grabs (a
 * grabber, a header). `offset` follows the finger 1:1 for the sheet's
 * transform; letting go past {@link DISMISS_DRAG_PX} calls `onDismiss`, and
 * anything shorter springs back. Call `reset` when the close completes.
 * Disabled, the handlers do nothing.
 */
export function useSheetDrag(
  onDismiss: () => void,
  enabled = true,
): { offset: number; handlers: SheetDragHandlers; reset: () => void } {
  const [offset, setOffset] = useState(0);
  const start = useRef<number | null>(null);
  /* The release decides on the latest distance, not the last render's: a
     quick flick lifts the finger before React has drawn its final move. */
  const distance = useRef(0);

  function end() {
    if (start.current === null) return;
    start.current = null;
    /* A dismissing drag keeps its offset, so the exit slides on from where
       the finger let go (`sheet-swipe-out`) instead of snapping back to the
       top first; the caller resets once the close completes. */
    if (distance.current > DISMISS_DRAG_PX) onDismiss();
    else setOffset(0);
    distance.current = 0;
  }

  return {
    offset,
    reset: () => setOffset(0),
    handlers: {
      onPointerDown(event) {
        if (!enabled || event.button !== 0) return;
        if (event.target instanceof Element && event.target.closest(INTERACTIVE)) return;
        start.current = event.clientY;
        event.currentTarget.setPointerCapture(event.pointerId);
      },
      onPointerMove(event) {
        if (start.current === null) return;
        const travelled = Math.max(0, event.clientY - start.current);
        if (travelled < DRAG_SLOP_PX && distance.current === 0) return;
        distance.current = travelled;
        setOffset(travelled);
      },
      onPointerUp: end,
      onPointerCancel: end,
    },
  };
}
