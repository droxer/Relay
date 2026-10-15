import { useSyncExternalStore } from "react";
import type { LandingTheme } from "../lib/landing";

/* The theme actually painted, read from html[data-theme] — the one attribute
   the pre-paint script and applyTheme() both write, with "system" already
   resolved. Watching the attribute rather than the saved preference keeps a
   reader in step with an OS flip while the preference is "system". */
function subscribe(onChange: () => void): () => void {
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
  return () => observer.disconnect();
}

function snapshot(): LandingTheme {
  return document.documentElement.getAttribute("data-theme") === "light" ? "light" : "dark";
}

/* The static export prerenders without a document; dark is the canvas the
   pre-paint script falls back to. */
function serverSnapshot(): LandingTheme {
  return "dark";
}

export function useResolvedTheme(): LandingTheme {
  return useSyncExternalStore(subscribe, snapshot, serverSnapshot);
}
