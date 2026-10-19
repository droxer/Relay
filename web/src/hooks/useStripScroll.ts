"use client";

import { useEffect, type RefObject } from "react";

/** How far the edge fade reaches into a strip, in px (section-rail.css). */
const EDGE_FADE_PX = 48;

function isHorizontalScroller(element: HTMLElement): boolean {
  const { overflowX } = getComputedStyle(element);
  return (overflowX === "auto" || overflowX === "scroll") && element.scrollWidth > element.clientWidth + 1;
}

/** The element that scrolls `from` sideways: itself or its nearest ancestor. */
function horizontalScroller(from: HTMLElement): HTMLElement | null {
  for (let node: HTMLElement | null = from; node; node = node.parentElement) {
    if (isHorizontalScroller(node)) return node;
  }
  return null;
}

/** Marks which ends of a sideways strip have more behind them, so CSS can
 *  fade exactly those edges (`data-more-start`, `data-more-end`). */
function markEdges(strip: HTMLElement) {
  const max = strip.scrollWidth - strip.clientWidth;
  strip.toggleAttribute("data-more-start", strip.scrollLeft > 1);
  strip.toggleAttribute("data-more-end", max - strip.scrollLeft > 1);
}

/**
 * A horizontal strip of tabs or chips (a section rail folded on a phone):
 * fades whichever edge has more to scroll to, and brings `activeSelector`
 * into view whenever `activeKey` changes.
 *
 * The selected item is centred rather than scrolled to the nearest edge.
 * "Nearest" parked the last chip flush against the right edge and left a
 * sliver of the first one behind on the left — "All open" selected read as a
 * stray "2" at the start of the row.
 */
export function useStripScroll(ref: RefObject<HTMLElement | null>, activeKey: unknown, activeSelector = '[data-active="true"]') {
  useEffect(() => {
    const strip = ref.current;
    if (!strip) return;
    const update = () => markEdges(strip);
    update();
    strip.addEventListener("scroll", update, { passive: true });
    const observer = typeof ResizeObserver === "function" ? new ResizeObserver(update) : null;
    observer?.observe(strip);
    return () => {
      strip.removeEventListener("scroll", update);
      observer?.disconnect();
    };
  }, [ref]);

  useEffect(() => {
    const root = ref.current;
    const active = root?.querySelector<HTMLElement>(activeSelector);
    if (!root || !active) return;
    const scroller = horizontalScroller(root);
    if (!scroller) {
      // Laid out vertically (a desktop rail): only its own list may move.
      active.scrollIntoView?.({ block: "nearest", inline: "nearest" });
      return;
    }
    const box = scroller.getBoundingClientRect();
    const item = active.getBoundingClientRect();
    const visible = item.left >= box.left + EDGE_FADE_PX && item.right <= box.right - EDGE_FADE_PX;
    if (visible) return;
    const centre = scroller.scrollLeft + (item.left - box.left) - (box.width - item.width) / 2;
    scroller.scrollLeft = Math.max(0, Math.min(centre, scroller.scrollWidth - scroller.clientWidth));
  }, [ref, activeKey, activeSelector]);
}
