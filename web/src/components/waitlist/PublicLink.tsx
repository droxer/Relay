"use client";

import type { MouseEvent, ReactNode } from "react";
import { navigateToAppPath } from "../../lib/appRoute";

/** A link between the signed-out pages. A real `<a href>` so it opens in a
    new tab and copies like any link; a plain click stays in the app instead
    of reloading it, the same as the rail's rows. */
export function PublicLink({ href, children }: { href: string; children: ReactNode }) {
  function handleClick(event: MouseEvent<HTMLAnchorElement>) {
    if (event.defaultPrevented || event.button !== 0) return;
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    void navigateToAppPath(href);
  }
  return (
    <a className="login-link" href={href} onClick={handleClick}>
      {children}
    </a>
  );
}
