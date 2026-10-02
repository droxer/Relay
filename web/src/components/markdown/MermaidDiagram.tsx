"use client";

import { useEffect, useState, useSyncExternalStore, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { diagramElementId, mermaidConfig } from "../../lib/markdown";

let sequence = 0;

function prefersDark(): boolean {
  if (typeof document === "undefined") return true;
  // Dark is the base palette; light is the override block in palette.css.
  return document.documentElement.getAttribute("data-theme") !== "light";
}

/** Tracks the app theme so a diagram re-renders when the user switches.
 *
 *  A diagram is baked into an SVG at render time, so unlike everything else on
 *  the page it cannot follow a theme change through CSS variables — a diagram
 *  drawn in dark and left alone becomes dark boxes on a light page. */
function subscribeTheme(onChange: () => void): () => void {
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
  return () => observer.disconnect();
}

function useIsDark(): boolean {
  return useSyncExternalStore(subscribeTheme, prefersDark, () => true);
}

/**
 * A ```mermaid fence drawn as an SVG.
 *
 * Mermaid is several hundred KB, so it is imported dynamically on first mount:
 * a transcript with no diagrams never pays for it. Until the import resolves —
 * and permanently, if the source does not parse — the caller's `fallback`
 * (the ordinary highlighted fence) stays on screen. A diagram that fails to
 * render should read as the code the agent wrote, never as a red error box in
 * the middle of a conversation.
 */
export function MermaidDiagram({ code, fallback }: { code: string; fallback: ReactNode }) {
  const { t } = useTranslation();
  const [svg, setSvg] = useState<string | null>(null);
  const dark = useIsDark();

  useEffect(() => {
    let cancelled = false;
    sequence += 1;
    const id = diagramElementId(sequence);

    void (async () => {
      try {
        const mermaid = (await import("mermaid")).default;
        mermaid.initialize(mermaidConfig(dark));
        const { svg: rendered } = await mermaid.render(id, code);
        if (!cancelled) setSvg(rendered);
      } catch {
        // Unparseable source or a failed chunk load: keep the fence.
        if (!cancelled) setSvg(null);
      }
    })();

    return () => {
      cancelled = true;
      // mermaid.render leaves its measuring node behind when a render is
      // abandoned mid-flight; drop it so repeated streams cannot accumulate
      // orphaned SVG in the body.
      document.getElementById(id)?.remove();
    };
  }, [code, dark]);

  if (svg === null) return <>{fallback}</>;

  return (
    <figure className="md-diagram" aria-label={t("message.diagram")}>
      {/* Mermaid output, produced under securityLevel "strict": no click
          bindings, no raw HTML labels. See mermaidConfig(). */}
      <div className="md-diagram-canvas" dangerouslySetInnerHTML={{ __html: svg }} />
      <figcaption className="sr-only">{code}</figcaption>
    </figure>
  );
}
