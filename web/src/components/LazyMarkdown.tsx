import { lazy, Suspense, useState } from "react";
import type { MarkdownVariant } from "../lib/markdown";

/* The markdown pipeline — react-markdown, remark/rehype, KaTeX, highlight.js —
   is ~570 KB of script. It sat in the eager bundle because the default route
   imports the transcript, so every page load paid for it, including pages
   that never render a message. It now loads when markdown first renders, and
   preloadMarkdown() lets a surface that is about to need it start early. */

type MarkdownModule = typeof import("./Markdown");

/* React.lazy suspends on its first render even when the chunk is already
   here, and a Suspense boundary that has shown its fallback holds the content
   back for React's ~300ms reveal throttle — so a preloaded pipeline still
   painted every turn as plain text and reflowed it a beat later. Once the
   module has resolved it is rendered directly; lazy only covers the wait.
   Each instance picks its path once, at mount: switching an instance mounted
   during the wait over to the direct path would remount its subtree. */
let loadedMarkdown: MarkdownModule | null = null;
let markdownRequest: Promise<MarkdownModule> | null = null;
const loadMarkdown = (): Promise<MarkdownModule> => {
  markdownRequest ??= import("./Markdown").then(
    (module) => (loadedMarkdown = module),
    (error: unknown) => {
      // A failed chunk may load on the next attempt (a deploy in between).
      markdownRequest = null;
      throw error;
    },
  );
  return markdownRequest;
};

const MarkdownImpl = lazy(() => loadMarkdown().then((module) => ({ default: module.Markdown })));
const MarkdownContentImpl = lazy(() => loadMarkdown().then((module) => ({ default: module.MarkdownContent })));

export function preloadMarkdown(): void {
  void loadMarkdown().catch(() => undefined);
}

/* Until the chunk lands the text shows as written, in the prose wrapper it will
   keep — the reader sees the words immediately rather than an empty turn. */
function PlainText({ text }: { text: string }) {
  return <p className="md-plain">{text}</p>;
}

export function Markdown({ text, variant = "chat" }: { text: string; variant?: MarkdownVariant }) {
  const [loaded] = useState(() => loadedMarkdown);
  if (loaded) return <loaded.Markdown text={text} variant={variant} />;
  return (
    <Suspense
      fallback={(
        <div className={`md-body ${variant === "document" ? "doc-prose" : "agent-prose"}`}>
          <PlainText text={text} />
        </div>
      )}
    >
      <MarkdownImpl text={text} variant={variant} />
    </Suspense>
  );
}

export function MarkdownContent({ text, live = false }: { text: string; live?: boolean }) {
  const [loaded] = useState(() => loadedMarkdown);
  if (loaded) return <loaded.MarkdownContent text={text} live={live} />;
  return (
    <Suspense fallback={<PlainText text={text} />}>
      <MarkdownContentImpl text={text} live={live} />
    </Suspense>
  );
}
