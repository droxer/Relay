import { lazy, Suspense } from "react";
import type { MarkdownVariant } from "../lib/markdown";

/* The markdown pipeline — react-markdown, remark/rehype, KaTeX, highlight.js —
   is ~570 KB of script. It sat in the eager bundle because the default route
   imports the transcript, so every page load paid for it, including pages
   that never render a message. It now loads when markdown first renders, and
   preloadMarkdown() lets a surface that is about to need it start early. */

const loadMarkdown = () => import("./Markdown");

const MarkdownImpl = lazy(() => loadMarkdown().then((module) => ({ default: module.Markdown })));
const MarkdownContentImpl = lazy(() => loadMarkdown().then((module) => ({ default: module.MarkdownContent })));

export function preloadMarkdown(): void {
  void loadMarkdown();
}

/* Until the chunk lands the text shows as written, in the prose wrapper it will
   keep — the reader sees the words immediately rather than an empty turn. */
function PlainText({ text }: { text: string }) {
  return <p className="md-plain">{text}</p>;
}

export function Markdown({ text, variant = "chat" }: { text: string; variant?: MarkdownVariant }) {
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
  return (
    <Suspense fallback={<PlainText text={text} />}>
      <MarkdownContentImpl text={text} live={live} />
    </Suspense>
  );
}
