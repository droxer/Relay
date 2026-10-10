import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ReactMarkdown from "react-markdown";
import rehypeKatex from "rehype-katex";
import rehypeSlug from "rehype-slug";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";

import {
  fenceLanguage,
  isDiagramFence,
  shouldRenderDiagram,
  markdownLinkKind,
  mermaidConfig,
  normalizeOverEscapedQuotes,
} from "../src/lib/markdown.js";

const readWeb = (rel: string) => readFileSync(`web/${rel}`, "utf8");

// Mirrors the plugin set in components/Markdown.tsx. The component itself
// cannot be imported here — packages/tsconfig.json excludes web/src/components
// — so the pipeline is exercised through the same plugins and the wiring is
// asserted against the source.
function render(markdown: string): string {
  return renderToStaticMarkup(
    createElement(ReactMarkdown, {
      remarkPlugins: [remarkGfm, remarkBreaks, remarkMath],
      rehypePlugins: [[rehypeKatex, { throwOnError: false, trust: false }], rehypeSlug],
      children: markdown,
    }),
  );
}

describe("markdown fence decisions", () => {
  it("reads the language off the code element's class", () => {
    assert.equal(fenceLanguage("language-TypeScript"), "typescript");
    assert.equal(fenceLanguage("language-c++"), "c++");
    assert.equal(fenceLanguage(""), null);
    assert.equal(fenceLanguage(undefined), null);
  });

  it("treats mermaid as a diagram dialect and nothing else", () => {
    assert.equal(isDiagramFence("mermaid"), true);
    assert.equal(isDiagramFence("ts"), false);
    assert.equal(isDiagramFence(null), false);
  });

  it("holds a diagram back until the stream settles", () => {
    // A live fence is a prefix of its source: parsing it throws, and retrying
    // per token would strobe. It stays highlighted code until the turn ends.
    assert.equal(shouldRenderDiagram("mermaid", true), false);
    assert.equal(shouldRenderDiagram("mermaid", false), true);
    assert.equal(shouldRenderDiagram("ts", false), false);
  });

  it("redraws a diagram when the theme changes", () => {
    // A diagram is baked into an SVG, so unlike the rest of the page it cannot
    // follow a theme switch through CSS variables — without this it stays dark
    // boxes on a light page.
    const diagram = readWeb("src/components/markdown/MermaidDiagram.tsx");
    assert.match(diagram, /attributeFilter: \["data-theme"\]/);
    assert.match(diagram, /\}, \[code, dark\]\);/);
  });

  it("pins mermaid to its strict security level", () => {
    // Diagram source is agent-authored. Strict is what disables click bindings
    // and raw HTML labels inside the SVG; nothing else in this renderer parses
    // raw HTML, so relaxing it here would be the only hole.
    assert.equal(mermaidConfig(true).securityLevel, "strict");
    assert.equal(mermaidConfig(false).securityLevel, "strict");
    assert.equal(mermaidConfig(true).theme, "dark");
    assert.equal(mermaidConfig(false).theme, "default");
    assert.equal(mermaidConfig(true).startOnLoad, false);
  });
});

describe("normalizeOverEscapedQuotes", () => {
  it("strips the backslash when every quote in the fence is escaped", () => {
    const escaped = [
      "def test_context_compression():",
      '    \\"\\"\\"测试上下文压缩\\"\\"\\"',
      "    manager = ContextManager(compression_threshold=3)",
      '    manager.init(\\"test\\")',
    ].join("\n");
    const fixed = normalizeOverEscapedQuotes(escaped);
    assert.doesNotMatch(fixed, /\\"/);
    assert.match(fixed, /"""测试上下文压缩"""/);
    assert.match(fixed, /manager\.init\("test"\)/);
    // Real newlines were never escaped, so line structure is untouched.
    assert.equal(fixed.split("\n").length, escaped.split("\n").length);
  });

  it("leaves code with a mix of escaped and bare quotes alone", () => {
    // A block that has both bare and escaped quotes is real code with a real
    // escape in it, not the whole-block artifact this heuristic targets.
    const code = 'print("hi")\nregex = "a\\"b"\nother = "c\\"d"\nlast = "e\\"f"';
    assert.equal(normalizeOverEscapedQuotes(code), code);
  });

  it("does nothing below the minimum escaped-quote count", () => {
    const code = 'x = "a\\"b"'; // one escaped quote pair only
    assert.equal(normalizeOverEscapedQuotes(code), code);
  });

  it("is a no-op for code with no quotes at all", () => {
    const code = "for i in range(10):\n    print(i)";
    assert.equal(normalizeOverEscapedQuotes(code), code);
  });
});

describe("markdown pipeline", () => {
  it("keeps a single newline as a line break", () => {
    // Agent CLIs hard-wrap prose and expect the wrap to show; CommonMark alone
    // would fold this into one line.
    assert.match(render("first\nsecond"), /first<br\/>\s*second/);
  });

  it("still collapses a wrapped paragraph across a blank line into two blocks", () => {
    const html = render("one\n\ntwo");
    assert.equal(html.match(/<p>/g)?.length, 2);
  });

  it("renders inline and display math", () => {
    assert.match(render("$x^2$"), /katex/);
    assert.match(render("$$\n x^2 \n$$"), /katex-display/);
  });

  it("does not throw on half-written display math", () => {
    // Mid-stream the closing $$ has not arrived yet. throwOnError:false keeps
    // it as text rather than blowing up the whole transcript render.
    assert.doesNotThrow(() => render("$$\n\\frac{1}{"));
  });

  it("gives headings stable ids for deep links", () => {
    assert.match(render("## Rollout plan"), /id="rollout-plan"/);
  });

  it("emits GFM footnotes as a trailing footnotes section", () => {
    const html = render("Body[^1]\n\n[^1]: The note.");
    assert.match(html, /data-footnotes/);
    assert.match(html, /data-footnote-ref/);
  });

  it("leaves raw HTML escaped", () => {
    // No rehype-raw: agent output is untrusted, so an embedded tag must read as
    // text, not become an element.
    const html = render('<img src=x onerror="alert(1)">');
    assert.doesNotMatch(html, /<img/);
    assert.match(html, /&lt;img/);
  });
});

describe("markdown component wiring", () => {
  const source = readWeb("src/components/Markdown.tsx");

  it("builds the plugin lists once at module scope", () => {
    // A fresh array literal per render is a new identity, which makes
    // react-markdown rebuild its processor on every streamed token.
    assert.match(source, /const REMARK_PLUGINS[^=]*=/);
    assert.match(source, /const REHYPE_PLUGINS[^=]*=/);
    assert.match(source, /remarkPlugins=\{REMARK_PLUGINS\}/);
    assert.match(source, /rehypePlugins=\{REHYPE_PLUGINS\}/);
  });

  it("never enables raw HTML or trusted KaTeX", () => {
    assert.doesNotMatch(source, /^import .*rehype-raw/m);
    assert.match(source, /trust:\s*false/);
  });

  it("wraps tables and fences unconditionally", () => {
    // Conditional wrapping would reshuffle the DOM at the moment a run settles,
    // and the streaming caret matches through this structure.
    assert.match(source, /table: MarkdownTable/);
    assert.match(readWeb("src/components/markdown/MarkdownTable.tsx"), /className="md-table"/);
    assert.match(readWeb("src/components/markdown/MarkdownFence.tsx"), /className="md-fence"/);
  });

  it("makes the table scroll region reachable by keyboard", () => {
    // A clipped table is mouse-only without this: the columns past the fold
    // cannot be scrolled to, and the region has no name to announce.
    const table = readWeb("src/components/markdown/MarkdownTable.tsx");
    assert.match(table, /tabIndex=\{0\}/);
    assert.match(table, /role="region"/);
    assert.match(table, /aria-label=\{t\("message\.table"\)\}/);
  });

  it("passes the live flag from the stream into the renderer", () => {
    assert.match(readWeb("src/components/AgentStream.tsx"), /<MarkdownContent text=\{visibleText\} live=\{live\} \/>/);
  });

  it("carries .md-body on the transcript wrapper", () => {
    // Every element rule in markdown.css is scoped to .md-body. The transcript
    // uses MarkdownContent directly, so without the class on this wrapper the
    // rules never match and headings/lists/code render as unstyled plain text.
    assert.match(readWeb("src/components/AgentStream.tsx"), /className="md-body agent-prose"/);
  });

  it("keeps react-markdown internals off the DOM table", () => {
    // The AST `node` prop spreads onto the element as node="[object Object]".
    assert.match(readWeb("src/components/markdown/MarkdownTable.tsx"), /omit\(props, "node"\)/);
  });

  it("renders the space and workspace previews at document scale", () => {
    const artifactBody = readWeb("src/components/artifact/ArtifactBody.tsx");
    assert.equal(artifactBody.match(/variant="document"/g)?.length, 2);
    assert.doesNotMatch(artifactBody, /<Markdown text=\{text\} \/>/);
    assert.match(readWeb("src/components/workspace/WorkspaceFilePreview.tsx"), /variant="document"/);
  });
});

describe("markdown stylesheet", () => {
  const markdownCss = readWeb("src/styles/markdown.css");
  const streamCss = readWeb("src/styles/agent-stream.css");

  it("shares element rules through .md-body rather than per-surface copies", () => {
    assert.match(markdownCss, /\.md-body table \{/);
    assert.match(markdownCss, /\.md-body section\[data-footnotes\]/);
    // The transcript sheet must not keep a second copy of the prose rules.
    assert.doesNotMatch(streamCss, /\.agent-prose (p|table|h1|blockquote) \{/);
  });

  it("gives tables their own scroll region", () => {
    assert.match(markdownCss, /\.md-table \{[^}]*overflow-x: auto/s);
  });

  it("signals that a clipped table has more to the side", () => {
    // Without this the table just stops mid-word and reads as truncated. The
    // `local` covers ride the content and unmask the fixed `scroll` shadows
    // only on the sides that still have content.
    const block = /\.md-table \{(.*?)\n\}/s.exec(markdownCss)?.[1] ?? "";
    assert.equal((block.match(/no-repeat local/g) ?? []).length, 2);
    assert.equal((block.match(/no-repeat scroll/g) ?? []).length, 2);
    // The clipped edge needs a legible frame, not the soft hairline.
    assert.match(block, /border: 1px solid var\(--line-1\)/);
  });

  it("keeps the streaming caret matching through the new wrappers", () => {
    // Wrapping the fence and table broke the old `> pre:last-child` /
    // `> table:last-child` hooks; these are their replacements.
    assert.match(streamCss, /\.agent-prose > \.md-fence:last-child pre > code::after/);
    assert.match(streamCss, /\.agent-prose > \.md-table:last-child tbody tr:last-child td:last-child::after/);
    // ...and the generic `div` branch must not also fire on those wrappers,
    // which would paint a second caret after the whole block.
    assert.match(streamCss, /:not\(\.md-fence, \.md-table\)::after/);
  });

  it("loads KaTeX inside the relay layer so app rules can still win", () => {
    assert.match(readWeb("src/styles.css"), /@import "katex\/dist\/katex\.min\.css" layer\(relay\)/);
  });

  it("moves the document variant up the type ladder", () => {
    assert.match(markdownCss, /\.doc-prose \{[^}]*font-size: var\(--fs-4\)/s);
    assert.match(markdownCss, /max-width: var\(--measure-wide\)/);
  });
});

describe("markdown link targets", () => {
  it("opens absolute URLs as external links", () => {
    assert.equal(markdownLinkKind("https://example.com/a"), "external");
    assert.equal(markdownLinkKind("mailto:ops@example.com"), "external");
    assert.equal(markdownLinkKind("//cdn.example.com/x.png"), "external");
  });

  it("keeps footnote and heading anchors in the same document", () => {
    assert.equal(markdownLinkKind("#user-content-fn-1"), "fragment");
    assert.equal(markdownLinkKind("#setup"), "fragment");
  });

  it("treats workspace-relative targets as inert", () => {
    assert.equal(markdownLinkKind("out/report.md"), "relative");
    assert.equal(markdownLinkKind("./chart.png"), "relative");
    assert.equal(markdownLinkKind("../README.md"), "relative");
    assert.equal(markdownLinkKind("/src/index.ts"), "relative");
  });

  it("has no target when react-markdown blanked an unsafe protocol", () => {
    assert.equal(markdownLinkKind(""), "none");
    assert.equal(markdownLinkKind(undefined), "none");
  });

  it("routes footnote refs through the fragment branch", () => {
    const html = render("A claim.[^1]\n\n[^1]: The source.");
    const href = /data-footnote-ref[^>]*href="([^"]+)"|href="([^"]+)"[^>]*data-footnote-ref/.exec(html);
    assert.ok(href, html);
    assert.equal(markdownLinkKind(href[1] ?? href[2]), "fragment");
  });

  it("wires the link and image overrides to the classification", () => {
    const source = readWeb("src/components/Markdown.tsx");
    assert.match(source, /markdownLinkKind\(href\)/);
    assert.match(source, /target="_blank"/);
    assert.match(source, /omit\(props, "node"\)/);
  });
});

describe("mermaid sizing", () => {
  it("draws diagrams at natural size so wide ones scroll", () => {
    const config = mermaidConfig(true);
    assert.equal(config.flowchart.useMaxWidth, false);
    assert.equal(config.sequence.useMaxWidth, false);
    const css = readWeb("src/styles/markdown.css");
    assert.match(css, /\.md-diagram-canvas svg \{[^}]*max-width: none;/s);
  });
});

describe("streaming caret on lists", () => {
  const streamCss = readWeb("src/styles/agent-stream.css");
  it("never matches the last item of every nested list", () => {
    assert.doesNotMatch(streamCss, /:is\(ul, ol\) li:last-child::after/);
    assert.match(streamCss, /:is\(ul, ol\) > li:last-child:not\(:has\(> :is\(ul, ol\):last-child\)\)::after/);
  });
});
