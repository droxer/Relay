"use client";

import { useCallback, useEffect, useRef } from "react";

/**
 * The draggable splitter between two shell columns.
 *
 * This is an ARIA *splitter* — `role="separator"` that is focusable and
 * carries a value — which is a different widget from the decorative divider
 * of the same role, and the reason it is a component rather than a use of
 * some `Separator` primitive: the value semantics (`aria-valuenow` and its
 * bounds) and the keyboard that changes them ARE the widget. A divider has
 * none of that.
 *
 * The sidenav rail, the thread list, and the thread space panel each wrote
 * this out in full: the same pointer-capture drag, the same
 * pointermove/pointerup/pointercancel trio, the same unmount release, the
 * same Home/Arrow keyboard, and the same seven ARIA attributes — three times,
 * ~45 lines each. They differed in exactly three things, which are the three
 * props below that are not just wiring: `clamp`, `defaultWidth`, and `grows`.
 *
 * Two subtleties worth keeping, because both are easy to "simplify" away:
 *
 * - The ceiling is fixed at gesture start, not re-measured per move. The
 *   neighbouring column shrinks as the drag proceeds, so re-measuring would
 *   let the panel walk past its own limit.
 * - `pointercancel` must finish the gesture. A cancelled gesture (system
 *   takeover, touch interruption) never fires `pointerup`, and without this
 *   the shell keeps its resizing state forever.
 */
export function ResizeHandle({
  className,
  label,
  width,
  min,
  max,
  defaultWidth,
  grows = "inline-end",
  clamp,
  ceiling,
  onResize,
  onResizeActive,
  step = 16,
}: {
  className: string;
  /** Names the splitter for assistive tech. */
  label: string;
  /** Current width, and the `aria-valuenow` reading. */
  width: number;
  /** Static bounds — the `aria-valuemin` / `aria-valuemax` readings. */
  min: number;
  max: number;
  /** Width `Home` restores. */
  defaultWidth: number;
  /**
   * Which way a drag GROWS the panel. `inline-end` for a panel left of its
   * neighbour (the rail, the thread list): dragging right makes it wider.
   * `inline-start` for a panel on the right (the space panel), where the
   * gesture and the arrow keys both invert.
   */
  grows?: "inline-start" | "inline-end";
  /** The panel's own floor/ceiling clamp, given the live ceiling. */
  clamp: (width: number, max: number) => number;
  /**
   * The live ceiling, measured against the neighbouring column. Called once
   * per gesture and once per key press — never per pointer move.
   */
  ceiling: () => number;
  onResize: (width: number, commit: boolean) => void;
  onResizeActive: (active: boolean) => void;
  step?: number;
}) {
  const sign = grows === "inline-end" ? 1 : -1;

  // A drag registers listeners outside React; this releases them if the panel
  // unmounts mid-gesture, which would otherwise leak the listeners and strand
  // the shell in its resizing state.
  const releaseDragRef = useRef<(() => void) | null>(null);
  useEffect(() => () => releaseDragRef.current?.(), []);

  const startResize = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    const handle = event.currentTarget;
    const startX = event.clientX;
    const limit = ceiling();
    handle.setPointerCapture(event.pointerId);
    onResizeActive(true);

    const widthAt = (clientX: number) => clamp(width + sign * (clientX - startX), limit);
    const move = (moveEvent: PointerEvent) => onResize(widthAt(moveEvent.clientX), false);
    const finish = (finalX: number | null) => {
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", up);
      handle.removeEventListener("pointercancel", cancel);
      releaseDragRef.current = null;
      if (finalX !== null) onResize(widthAt(finalX), true);
      onResizeActive(false);
    };
    const up = (upEvent: PointerEvent) => finish(upEvent.clientX);
    const cancel = () => finish(null);

    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", up);
    handle.addEventListener("pointercancel", cancel);
    releaseDragRef.current = () => finish(null);
  }, [ceiling, clamp, onResize, onResizeActive, sign, width]);

  const resizeByKeyboard = useCallback((event: React.KeyboardEvent<HTMLDivElement>) => {
    const limit = ceiling();
    if (event.key === "Home") {
      event.preventDefault();
      onResize(clamp(defaultWidth, limit), true);
      return;
    }
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    // The arrow that grows the panel is the one pointing the way it grows.
    const delta = (event.key === "ArrowRight" ? 1 : -1) * sign * step;
    onResize(clamp(width + delta, limit), true);
  }, [ceiling, clamp, defaultWidth, onResize, sign, step, width]);

  return (
    <div
      className={className}
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuenow={width}
      aria-valuemin={min}
      aria-valuemax={max}
      tabIndex={0}
      onPointerDown={startResize}
      onKeyDown={resizeByKeyboard}
    />
  );
}
