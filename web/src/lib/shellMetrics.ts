/** What the shell's resizable columns measure themselves against.
 *
 *  Both readings come from the environment rather than from React state,
 *  because the CSS grid — not React — owns the real widths: a rail's stored
 *  width is what it ASKED for, and between the track floors and the viewport
 *  caps in tokens/palette.css the rendered column is often something else.
 *
 *  One copy. The sidenav, the thread list and the space panel each had their
 *  own `chatWidth()` (identical but for the doc comment), which is how the
 *  same reading came to be spelled three times and would have been spelled
 *  six once each pane also needed the viewport. */

/** The chat column's rendered width, or null when it isn't in the DOM — a
 *  non-thread route, the prerender pass, a test environment. Callers treat
 *  null as "nothing to measure" and fall back to their absolute maximum. */
export function chatColumnWidth(): number | null {
  if (typeof document === "undefined") return null;
  const chat = document.getElementById("chat-panel");
  return chat ? chat.getBoundingClientRect().width : null;
}

/** The viewport width the `vw` caps resolve against, or null off-browser.
 *  `innerWidth` rather than `documentElement.clientWidth` on purpose: `vw`
 *  units include the scrollbar gutter, and the drag ceiling has to agree with
 *  CSS to the pixel or the handle drifts from the edge it is dragging. */
export function viewportWidth(): number | null {
  if (typeof window === "undefined") return null;
  return window.innerWidth;
}
