import { isValidElement, useMemo, type ComponentProps, type ReactElement, type ReactNode } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import rehypeKatex from "rehype-katex";
import rehypeSlug from "rehype-slug";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";

import { fenceLanguage, normalizeOverEscapedQuotes, type MarkdownVariant } from "../lib/markdown";
import { MarkdownModeProvider } from "./markdown/context";
import { MarkdownFence } from "./markdown/MarkdownFence";
import { MarkdownTable } from "./markdown/MarkdownTable";

type CodeProps = { className?: string; children?: ReactNode };

function nodeText(children: ReactNode): string {
  if (typeof children === "string") return children;
  if (Array.isArray(children)) return children.map(nodeText).join("");
  return "";
}

// Plugin arrays are module constants on purpose. A fresh array literal is a new
// identity on every render, which makes react-markdown rebuild the whole
// processor — once per streamed token, on the hot path.
type MarkdownOptions = ComponentProps<typeof ReactMarkdown>;

const REMARK_PLUGINS: MarkdownOptions["remarkPlugins"] = [
  remarkGfm,
  // Agent CLIs emit hard-wrapped prose and expect the wrap to show. CommonMark
  // folds a single newline into a space; remark-breaks keeps it a line break.
  remarkBreaks,
  // Display math only. `$…$` is not math in this transcript, it is money and
  // shell variables — "costs $5 per seat and $10 for pro" was typeset as an
  // equation, dollar signs and spacing gone. `$$…$$` is unambiguous enough to
  // keep, so a real equation still renders.
  [remarkMath, { singleDollarTextMath: false }],
];

// No rehype-raw: Markdown here is agent-authored and therefore untrusted, so
// embedded HTML stays escaped. KaTeX runs with trust off for the same reason —
// \htmlClass and friends would reopen exactly that door.
const REHYPE_PLUGINS: MarkdownOptions["rehypePlugins"] = [
  [rehypeKatex, { throwOnError: false, trust: false, output: "htmlAndMathml" }],
  // Stable heading ids so a long document preview can be deep-linked.
  rehypeSlug,
];

// Shared GitHub-flavored Markdown renderer. A fenced code block always arrives
// as <pre><code>, inline code as a bare <code> — so the block chrome lives in
// the `pre` component. Sniffing newlines in `code` instead would misrender
// single-line fences as inline chips and multi-line code spans as blocks.
const MARKDOWN_COMPONENTS: Components = {
  pre: ({ children }) => {
    const code = isValidElement<CodeProps>(children)
      ? (children as ReactElement<CodeProps>)
      : null;
    const text = normalizeOverEscapedQuotes(nodeText(code?.props.children).replace(/\n$/, ""));
    return <MarkdownFence code={text} language={fenceLanguage(code?.props.className)} />;
  },
  // A GFM table is the one block that cannot be made to fit a narrow column by
  // wrapping: past a few columns it either overflows the transcript or crushes
  // its cells. Give it its own scroll region so the page never scrolls sideways.
  table: MarkdownTable,
  a: ({ href, children, ...rest }) => (
    <a href={href} target="_blank" rel="noreferrer noopener" {...rest}>
      {children}
    </a>
  ),
  // Intrinsic dimensions of markdown images are unknown, so no width/height
  // hints — just lazy-load them instead of blocking on the transcript render.
  img: ({ src, alt, ...rest }) => (
    // eslint-disable-next-line @next/next/no-img-element -- static export (no next/image optimizer); markdown images have no known size
    <img src={src} alt={alt ?? ""} loading="lazy" decoding="async" {...rest} />
  ),
};

/**
 * Renders agent-authored Markdown: GFM tables/strikethrough/task lists/
 * footnotes, highlighted code fences with a copy control, `$…$` math via
 * KaTeX, and ```mermaid fences as diagrams.
 *
 * Output is HTML-escaped — raw HTML is not parsed, highlight.js escapes fence
 * bodies, and Mermaid renders under its strict security level. Links open in a
 * new tab with `noopener`. Note that remote images referenced by the text still
 * load from their origin.
 *
 * `variant` picks the reading: `chat` matches the transcript's body rhythm,
 * `document` gives the thread space preview document scale and a measure.
 */
export function Markdown({ text, variant = "chat" }: { text: string; variant?: MarkdownVariant }) {
  return (
    <div className={`md-body ${variant === "document" ? "doc-prose" : "agent-prose"}`}>
      <MarkdownContent text={text} />
    </div>
  );
}

/** Markdown content without the prose wrapper, for composition in live output.
 *
 *  `live` marks the text as a prefix of an in-flight stream: a half-written
 *  fence is not yet a diagram and not yet worth copying. */
export function MarkdownContent({ text, live = false }: { text: string; live?: boolean }) {
  const mode = useMemo(() => ({ live }), [live]);
  return (
    <MarkdownModeProvider value={mode}>
      <ReactMarkdown
        remarkPlugins={REMARK_PLUGINS}
        rehypePlugins={REHYPE_PLUGINS}
        components={MARKDOWN_COMPONENTS}
      >
        {text}
      </ReactMarkdown>
    </MarkdownModeProvider>
  );
}
