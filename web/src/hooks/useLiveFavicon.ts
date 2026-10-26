import { useEffect } from "react";
import { faviconDataUri, type FaviconState } from "../lib/faviconState";
import { useResolvedTheme } from "./useResolvedTheme";

const ICON_LINKS = 'link[rel~="icon"]';

/**
 * Point the tab's icon at the mark for `state` while the signed-in app is
 * mounted, and hand the static favicon back when it unmounts (sign-out
 * returns to the landing page, which keeps the full-colour mark). The mark
 * draws in the register the app is painted in, so a theme switch repaints it.
 */
export function useLiveFavicon(state: FaviconState): void {
  const theme = useResolvedTheme();
  // Declared first so it records the shipped hrefs before the effect below
  // rewrites them.
  useEffect(() => {
    const links = [...document.querySelectorAll<HTMLLinkElement>(ICON_LINKS)];
    const shipped = links.map((link) => ({ link, href: link.getAttribute("href"), type: link.getAttribute("type") }));
    return () => {
      for (const { link, href, type } of shipped) {
        if (href !== null) link.setAttribute("href", href);
        if (type !== null) link.setAttribute("type", type);
      }
    };
  }, []);

  useEffect(() => {
    const href = faviconDataUri(state, theme);
    for (const link of document.querySelectorAll<HTMLLinkElement>(ICON_LINKS)) {
      link.setAttribute("type", "image/svg+xml");
      link.setAttribute("href", href);
    }
  }, [state, theme]);
}
