import { useEffect, useMemo, useState } from "react";
import { highlightIfLoaded, loadSyntax, syntaxLoaded } from "../lib/syntaxLoader";

/** Syntax-highlighted HTML for `code`, rendered as escaped plain text for the
 *  one paint before highlight.js loads (see lib/syntaxLoader). */
export function useHighlightedHtml(code: string, language?: string | null): string {
  const [ready, setReady] = useState(syntaxLoaded);
  useEffect(() => {
    if (ready) return;
    let live = true;
    void loadSyntax().then(() => {
      if (live) setReady(true);
    });
    return () => {
      live = false;
    };
  }, [ready]);
  return useMemo(() => highlightIfLoaded(code, language), [code, language, ready]);
}
