import { isValidElement, memo, useMemo, type ComponentProps, type ReactElement, type ReactNode } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import rehypeKatex from "rehype-katex";
import rehypeSlug from "rehype-slug";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";

import {
  fenceLanguage,
  markdownLinkKind,
  normalizeMathDelimiters,
  normalizeOverEscapedQuotes,
  type MarkdownVariant,
} from "../lib/markdown";
import { omit } from "../lib/omit";
import { splitInlineMentions, splitLeadingMentionPrefix } from "../lib/mentions";
import { MarkdownModeProvider, useMarkdownMode } from "./markdown/context";
import { MarkdownFence } from "./markdown/MarkdownFence";
import { MarkdownTable } from "./markdown/MarkdownTable";

function renderMentionSegments(
  segments: Array<{ text: string; mention: boolean }>,
  keyPrefix = "",
  mentionableNames?: ReadonlyMap<string, string>,
  onMentionClick?: (displayName: string) => void,
): ReactNode {
  return segments.map((segment, index) => {
    if (!segment.mention) return segment.text;
    const targetName = mentionableNames?.get(segment.text.slice(1).toLowerCase());
    if (onMentionClick && targetName) {
      return (
        <button
          key={`${keyPrefix}${index}`}
          type="button"
          className="msg-mention msg-mention-interactive"
          translate="no"
          onClick={() => onMentionClick(targetName)}
        >
          {segment.text}
        </button>
      );
    }
    return (
      <span key={`${keyPrefix}${index}`} className="msg-mention" translate="no">
        {segment.text}
      </span>
    );
  });
}

function highlightParagraphMentions(
  children: ReactNode,
  tokens: readonly string[],
  mentionableNames?: ReadonlyMap<string, string>,
  onMentionClick?: (displayName: string) => void,
): ReactNode {
  if (typeof children === "string") {
    const segments = splitLeadingMentionPrefix(children, tokens);
    return segments.some((segment) => segment.mention)
      ? renderMentionSegments(segments, "", mentionableNames, onMentionClick)
      : children;
  }
  if (Array.isArray(children) && children.length > 0 && typeof children[0] === "string") {
    const segments = splitLeadingMentionPrefix(children[0], tokens);
    if (!segments.some((segment) => segment.mention)) return children;
    return [renderMentionSegments(segments, "m-", mentionableNames, onMentionClick), ...children.slice(1)];
  }
  return children;
}

function highlightInlineMentions(
  children: ReactNode,
  names: readonly string[],
  mentionableNames?: ReadonlyMap<string, string>,
  onMentionClick?: (displayName: string) => void,
): ReactNode {
  if (typeof children === "string") {
    if (!children.includes("@")) return children;
    const segments = splitInlineMentions(children, names);
    return segments.some((segment) => segment.mention)
      ? renderMentionSegments(segments, "", mentionableNames, onMentionClick)
      : children;
  }
  if (Array.isArray(children)) {
    let changed = false;
    const next = children.map((child, index) => {
      if (typeof child !== "string" || !child.includes("@")) return child;
      const segments = splitInlineMentions(child, names);
      if (!segments.some((segment) => segment.mention)) return child;
      changed = true;
      return renderMentionSegments(segments, `i-${index}-`, mentionableNames, onMentionClick);
    });
    return changed ? next : children;
  }
  return children;
}

function MarkdownParagraph({
  children,
  node,
  ...props
}: ComponentProps<"p"> & { node?: { position?: { start?: { line?: number } } } }) {
  const { leadingMentions, inlineMentionNames, mentionableNames, onMentionClick } = useMarkdownMode();
  let content = children;
  if (leadingMentions?.length && node?.position?.start?.line === 1) {
    content = highlightParagraphMentions(content, leadingMentions, mentionableNames, onMentionClick);
  } else if (inlineMentionNames?.length) {
    content = highlightInlineMentions(content, inlineMentionNames, mentionableNames, onMentionClick);
  }
  return <p {...props}>{content}</p>;
}

function MarkdownListItem({ children, ...props }: ComponentProps<"li">) {
  const { inlineMentionNames, mentionableNames, onMentionClick } = useMarkdownMode();
  const rest = omit(props as Record<string, unknown>, "node") as ComponentProps<"li">;
  const content = inlineMentionNames?.length
    ? highlightInlineMentions(children, inlineMentionNames, mentionableNames, onMentionClick)
    : children;
  return <li {...rest}>{content}</li>;
}

function MarkdownBlockquote({ children, ...props }: ComponentProps<"blockquote">) {
  const { inlineMentionNames, mentionableNames, onMentionClick } = useMarkdownMode();
  const rest = omit(props as Record<string, unknown>, "node") as ComponentProps<"blockquote">;
  const content = inlineMentionNames?.length
    ? highlightInlineMentions(children, inlineMentionNames, mentionableNames, onMentionClick)
    : children;
  return <blockquote {...rest}>{content}</blockquote>;
}

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
  // `$$` only. remark-math's own `$…$` typeset "costs $5 per seat and $10 for
  // pro" as an equation; normalizeMathDelimiters decides which `$…$`, `\(…\)`
  // and `\[…\]` are math and rewrites just those to `$$`.
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
  p: MarkdownParagraph,
  li: MarkdownListItem,
  blockquote: MarkdownBlockquote,
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
  // react-markdown hands every override its AST `node`; spread onto the DOM it
  // renders as `node="[object Object]"`, so it is dropped before the spread.
  a: ({ href, children, ...props }) => {
    const rest = omit(props, "node");
    const kind = markdownLinkKind(href);
    if (kind === "external") {
      return (
        <a href={href} target="_blank" rel="noreferrer noopener" {...rest}>
          {children}
        </a>
      );
    }
    // Footnote refs/backrefs and heading anchors scroll within this document.
    if (kind === "fragment") return <a href={href} {...rest}>{children}</a>;
    // A workspace-relative target has no URL in this app; keep it readable,
    // not clickable (see markdownLinkKind).
    return <span className="md-link-inert" title={href || undefined}>{children}</span>;
  },
  // Intrinsic dimensions of markdown images are unknown, so no width/height
  // hints — just lazy-load them instead of blocking on the transcript render.
  img: ({ src, alt, ...props }) => {
    const rest = omit(props, "node");
    const href = typeof src === "string" ? src : undefined;
    if (markdownLinkKind(href) !== "external") {
      // A relative image would resolve against the app origin and paint a
      // broken-image box; say what it was instead.
      return <span className="md-image-inert" title={href || undefined}>{alt || href}</span>;
    }
    return (
      // eslint-disable-next-line @next/next/no-img-element -- static export (no next/image optimizer); markdown images have no known size
      <img src={href} alt={alt ?? ""} loading="lazy" decoding="async" {...rest} />
    );
  },
};

/**
 * Renders agent-authored Markdown: GFM tables/strikethrough/task lists/
 * footnotes, highlighted code fences with a copy control, TeX math via KaTeX
 * (`$$…$$`, `\[…\]`, `\(…\)`, and `$…$` that reads as TeX — see
 * normalizeMathDelimiters), and ```mermaid fences as diagrams.
 *
 * Output is HTML-escaped — raw HTML is not parsed, highlight.js escapes fence
 * bodies, and Mermaid renders under its strict security level. Absolute links
 * open in a new tab with `noopener`; `#` links stay in place; workspace-relative
 * links and images render inert. Note that remote images referenced by the
 * text still load from their origin.
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
 *  fence is not yet a diagram and not yet worth copying.
 *
 *  Memoized: a full react-markdown parse runs every plugin over the whole
 *  text, so a parent re-render with the same text must not repeat it. Streamed
 *  output renders as one of these per block (lib/markdownBlocks), so settled
 *  blocks skip the parse while only the growing tail re-runs it. */
export const MarkdownContent = memo(function MarkdownContent({
  text,
  live = false,
  leadingMentions,
  inlineMentionNames,
  mentionableNames,
  onMentionClick,
}: {
  text: string;
  live?: boolean;
  leadingMentions?: readonly string[];
  inlineMentionNames?: readonly string[];
  mentionableNames?: ReadonlyMap<string, string>;
  onMentionClick?: (displayName: string) => void;
}) {
  const mode = useMemo(
    () => ({ live, leadingMentions, inlineMentionNames, mentionableNames, onMentionClick }),
    [live, leadingMentions, inlineMentionNames, mentionableNames, onMentionClick],
  );
  return (
    <MarkdownModeProvider value={mode}>
      <ReactMarkdown
        remarkPlugins={REMARK_PLUGINS}
        rehypePlugins={REHYPE_PLUGINS}
        components={MARKDOWN_COMPONENTS}
      >
        {normalizeMathDelimiters(text)}
      </ReactMarkdown>
    </MarkdownModeProvider>
  );
});
