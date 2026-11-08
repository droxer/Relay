/**
 * Tapping the tab you are already on: the phone tab bar's second gesture.
 *
 * On a nested screen the route's own navigation already pops back to its
 * root. At the root the URL does not change, so navigation is a no-op; there
 * a native tab bar scrolls the screen back to its top instead. That is what
 * `scrollPanesToTop` does.
 */

/** True when `href` names the screen the browser is already on: the tap
 *  cannot navigate, so it should scroll instead. */
export function isAtTabRoot(href: string, location: Pick<Location, "pathname" | "search">): boolean {
  return `${location.pathname}${location.search}` === href;
}

function isRendered(element: Element): boolean {
  return element.getClientRects().length > 0;
}

/**
 * Scroll every pane under `root` that has been scrolled back to its top, and
 * skip anything inside `exclude` (the tab bar itself). The screen is not
 * marked up with one scroller, so this looks for one: whatever is scrolled
 * and still rendered. Returns how many panes moved.
 */
export function scrollPanesToTop(root: Element, { exclude, smooth }: { exclude?: Element | null; smooth: boolean }): number {
  const behavior: ScrollBehavior = smooth ? "smooth" : "auto";
  let moved = 0;
  for (const element of root.querySelectorAll<HTMLElement>("*")) {
    if (element.scrollTop <= 0) continue;
    if (exclude?.contains(element)) continue;
    if (!isRendered(element)) continue;
    element.scrollTo({ top: 0, behavior });
    moved += 1;
  }
  return moved;
}
