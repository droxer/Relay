import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

describe("streaming prose continuity", () => {
  it("parses settled prose as one canonical Markdown document", () => {
    const source = readFileSync("web/src/components/AgentStream.tsx", "utf8");

    // While live, prose renders as memoized blocks so a frame re-parses only
    // the growing tail; splitMarkdownBlocks never cuts a list, fence, or math
    // block (web/tests/markdownBlocks.test.ts). Once settled, the whole text is
    // parsed once, so the final tree and heading ids match a single document.
    assert.match(source, /live \? <StreamingMarkdown text=\{visibleText\} live \/> : <MarkdownContent text=\{visibleText\} \/>/);
    assert.doesNotMatch(source, /splitStreamingMarkdown/);
  });

  it("keeps a loose list as one semantic list", () => {
    const html = renderToStaticMarkup(createElement(ReactMarkdown, {
      remarkPlugins: [remarkGfm],
      children: "- first\n\n- second",
    }));

    assert.equal(html.match(/<ul>/g)?.length, 1);
    assert.equal(html.match(/<li>/g)?.length, 2);
  });
});
