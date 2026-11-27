/** Pure decisions behind the Markdown renderer.
 *
 * These live outside the component so they can be unit-tested — `web/tests`
 * compiles against `packages/tsconfig.json`, which excludes `web/src/components`.
 */

/** Reading context a Markdown body is rendered into.
 *
 * `chat` is the transcript column: body copy sized to match the user bubble so
 * both voices share one rhythm. `document` is the thread space preview, where
 * the same Markdown is a standalone artifact and wants document scale, a
 * reading measure, and prose leading (the heading ladder is shared — see
 * styles/markdown.css).
 */
export type MarkdownVariant = "chat" | "document";

/** Fence languages rendered as a diagram rather than highlighted source. */
const DIAGRAM_LANGUAGES = new Set(["mermaid"]);

/**
 * Language of a fenced block, read off the `language-*` class react-markdown
 * puts on the inner `<code>`. Returns null for a bare fence.
 */
export function fenceLanguage(className: string | undefined | null): string | null {
  const match = /language-([\w+-]+)/.exec(className ?? "");
  return match ? match[1].toLowerCase() : null;
}

/** Whether a fence language names a diagram dialect. */
export function isDiagramFence(language: string | null): boolean {
  return language !== null && DIAGRAM_LANGUAGES.has(language);
}

/**
 * Whether a diagram fence should actually be drawn.
 *
 * A streaming fence is a prefix of its final source: `graph TD\n  A -->` is not
 * a diagram, it is the first half of one. Parsing it throws, and re-parsing on
 * every token would strobe the transcript. So a live fence stays highlighted
 * source and becomes a diagram once the turn settles — the block keeps its
 * place in the flow either way.
 */
export function shouldRenderDiagram(language: string | null, live: boolean): boolean {
  return !live && isDiagramFence(language);
}

const NATURAL_SIZE = { useMaxWidth: false } as const;

/**
 * Mermaid runtime configuration.
 *
 * `securityLevel: "strict"` is load-bearing, not a default worth relaxing:
 * diagram source is agent-authored and therefore untrusted, and strict is what
 * disables click bindings and raw HTML labels inside the rendered SVG. The rest
 * of this renderer keeps raw HTML escaped (no rehype-raw); Mermaid must not
 * become the hole in that.
 */
export function mermaidConfig(dark: boolean) {
  return {
    startOnLoad: false,
    securityLevel: "strict",
    theme: dark ? "dark" : "default",
    fontFamily: "inherit",
    // Draw at natural size. Mermaid's default (`width="100%"` plus an inline
    // max-width) shrinks a wide diagram to the transcript column until its
    // labels are unreadable; at natural size the figure scrolls instead.
    flowchart: NATURAL_SIZE,
    sequence: NATURAL_SIZE,
    class: NATURAL_SIZE,
    state: NATURAL_SIZE,
    er: NATURAL_SIZE,
    gantt: NATURAL_SIZE,
    journey: NATURAL_SIZE,
    pie: NATURAL_SIZE,
    gitGraph: NATURAL_SIZE,
    mindmap: NATURAL_SIZE,
    timeline: NATURAL_SIZE,
    requirement: NATURAL_SIZE,
  } as const;
}

/** Stable, DOM-safe id for a Mermaid render pass. */
export function diagramElementId(seq: number): string {
  return `relay-mermaid-${seq}`;
}

/** Minimum escaped-quote pairs before {@link normalizeOverEscapedQuotes} acts —
 * high enough that a single legitimate `\"` inside otherwise normal code
 * can't trigger it. */
const OVER_ESCAPED_QUOTE_MIN_COUNT = 4;

/**
 * Best-effort repair for a fence whose text arrived with every `"` backslash-
 * escaped — the signature an agent leaves behind when it echoes a JSON-
 * encoded string (e.g. a tool result's `content` field) straight into its
 * reply instead of the decoded value. Real newlines survive that failure
 * mode (only the quote escaping leaks through), so this targets `\"` alone
 * rather than attempting a general JSON-string unescape.
 *
 * Deliberately conservative: fires only when *every* quote in the block is
 * escaped, and there are enough of them that ordinary code containing one
 * genuine `\"` is left untouched. A block that mixes escaped and bare quotes
 * is real code with a real escape in it, not this bug, and is returned as-is.
 */
export function normalizeOverEscapedQuotes(code: string): string {
  const quoteCount = (code.match(/"/g) ?? []).length;
  if (quoteCount < OVER_ESCAPED_QUOTE_MIN_COUNT) return code;
  const escapedQuoteCount = (code.match(/\\"/g) ?? []).length;
  if (escapedQuoteCount !== quoteCount) return code;
  return code.replace(/\\"/g, '"');
}

/** A fence opener or closer: three or more backticks or tildes. */
const FENCE_LINE = /^\s*(`{3,}|~{3,})/;

/** An inline code span; math is never read inside one. */
const CODE_SPAN = /(`+)[\s\S]*?[^`]\1(?!`)/g;

/** Math in prose, in priority order: `$$…$$` (what the renderer already reads,
 * kept as is so its dollars never feed the single-dollar arm), `\[…\]`,
 * `\(…\)`, then `$…$`. A backslash before an opener escapes it. The
 * single-dollar arm follows Pandoc's rule — no space just inside either
 * dollar, no word character or digit right after the closing one — so
 * "$5 and $10" or "$HOME/$USER" never pair up. */
const MATH_SPAN =
  /\$\$[\s\S]+?\$\$|(?<!\\)\\\[([\s\S]+?)\\\]|(?<!\\)\\\(([\s\S]+?)\\\)|(?<![\\$\w])\$(?![\s$])((?:\\.|[^$\n\\])+?)(?<![\s\\])\$(?![\w$])/g;

/** What a single-dollar span needs to read as math rather than a price or a
 * shell variable: a TeX command or operator, or a lone letter (`$x$`). */
const TEX_SIGNAL = /[\\^_{}=<>+]|^[A-Za-z]$/;

function lineBefore(text: string, offset: number): string {
  return text.slice(text.lastIndexOf("\n", offset - 1) + 1, offset);
}

function lineAfter(text: string, offset: number): string {
  const end = text.indexOf("\n", offset);
  return text.slice(offset, end < 0 ? text.length : end);
}

/** `\[…\]` standing on its own lines becomes a `$$` flow block, every line
 * keeping the indentation and `>` markers that hold it in its list item or
 * quote. Mid-sentence it can only be inline math. */
function displayMath(body: string, source: string, start: number, end: number): string {
  const prefix = lineBefore(source, start);
  if (!/^[ \t>]*$/.test(prefix) || lineAfter(source, end).trim() !== "") return `$$${body.trim()}$$`;
  const lines = body.split("\n");
  const first = lines[0].trim();
  const last = lines.length > 1 ? lines[lines.length - 1] : "";
  const middle = lines.slice(1, lines.length > 1 ? -1 : 1);
  const inner = [
    ...(first ? [`${prefix}${first}`] : []),
    ...middle,
    ...(last.replace(/^[ \t>]*/, "").trim() ? [last.trimEnd()] : []),
  ];
  return ["$$", ...inner, `${prefix}$$`].join("\n");
}

function normalizeProse(source: string): string {
  return source.replace(MATH_SPAN, (match: string, display: string | undefined, inline: string | undefined, dollar: string | undefined, offset: number) => {
    const body = display ?? inline ?? dollar;
    // `$$…$$` is already right; math across a blank line is two paragraphs.
    if (body === undefined || /\n[ \t>]*\n/.test(body)) return match;
    if (display !== undefined) return displayMath(display, source, offset, offset + match.length);
    if (inline !== undefined) return `$$${inline.trim()}$$`;
    return TEX_SIGNAL.test(body) ? `$$${body}$$` : match;
  });
}

/** Normalizes prose between inline code spans, leaving the spans as written. */
function normalizeOutsideCodeSpans(chunk: string): string {
  let out = "";
  let last = 0;
  for (const span of chunk.matchAll(CODE_SPAN)) {
    out += normalizeProse(chunk.slice(last, span.index)) + span[0];
    last = span.index + span[0].length;
  }
  return out + normalizeProse(chunk.slice(last));
}

/**
 * Rewrites the TeX delimiters agents write into the one the renderer parses.
 *
 * remark-math reads only `$$…$$` here — its single-dollar mode is off because
 * "$5 and $10" is money, not an equation. But models write `\(…\)`, `\[…\]`
 * and `$x^2$` as often as `$$`, and CommonMark reads `\[` as an escaped
 * bracket, so those arrived as literal source. This turns `\[…\]` on its own
 * lines into a `$$` display block, `\(…\)` into inline `$$…$$`, and `$…$`
 * into inline math only when it passes Pandoc's spacing rule and reads as
 * TeX. Fenced code and inline code spans are left as written.
 */
export function normalizeMathDelimiters(text: string): string {
  if (!/[$\\]/.test(text)) return text;
  const out: string[] = [];
  let prose: string[] = [];
  let fence: string | null = null;
  const flush = () => {
    if (prose.length > 0) out.push(normalizeOutsideCodeSpans(prose.join("\n")));
    prose = [];
  };
  for (const line of text.split("\n")) {
    const marker = FENCE_LINE.exec(line)?.[1];
    if (fence !== null) {
      out.push(line);
      if (marker && marker[0] === fence[0] && marker.length >= fence.length && line.trim() === marker) fence = null;
    } else if (marker) {
      flush();
      out.push(line);
      fence = marker;
    } else {
      prose.push(line);
    }
  }
  flush();
  return out.join("\n");
}

/** What a Markdown link or image target points at, which decides how it renders.
 *
 * - `external`: an absolute `http:`/`https:`/`mailto:` URL or a `//host`
 *   one — a real destination, opened in a new tab.
 * - `unsafe`: any other scheme (`javascript:`, `vbscript:`, `data:`, `file:`,
 *   …). react-markdown's default `urlTransform` already blanks the dangerous
 *   ones to "", so this is the second line: should that transform ever be
 *   replaced, such a target still renders inert rather than as a live link.
 * - `fragment`: `#…` — a footnote or heading in the same document. It must stay
 *   in this tab; opening a new tab to scroll to a footnote reloads the app.
 * - `relative`: anything else. Agent prose says `[report](out/report.md)` or
 *   `![](./chart.png)` meaning a file in its workspace, but the browser resolves
 *   it against the app's own origin. The transcript can look these up in the
 *   Thread's indexed files. Other renderers keep the file name as text.
 * - `none`: no target at all (react-markdown blanks unsafe protocols to "").
 */
export type MarkdownLinkKind = "external" | "fragment" | "relative" | "unsafe" | "none";

const SAFE_LINK_SCHEMES = new Set(["http", "https", "mailto"]);

export function markdownLinkKind(href: string | null | undefined): MarkdownLinkKind {
  const target = href?.trim() ?? "";
  if (!target) return "none";
  if (target.startsWith("#")) return "fragment";
  if (target.startsWith("//")) return "external";
  const scheme = /^([a-z][a-z\d+.-]*):/i.exec(target)?.[1]?.toLowerCase();
  if (scheme === undefined) return "relative";
  return SAFE_LINK_SCHEMES.has(scheme) ? "external" : "unsafe";
}
