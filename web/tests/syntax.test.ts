import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { LANGUAGE_BY_EXTENSION } from "../src/lib/fileKinds.js";
import { highlightToHtml, isPlainLanguage, resolveLanguage } from "../src/lib/syntax.js";

describe("resolveLanguage", () => {
  it("resolves a registered grammar name directly", () => {
    assert.equal(resolveLanguage("python"), "python");
  });

  it("resolves short aliases to their full grammar name", () => {
    assert.equal(resolveLanguage("ts"), "typescript");
    assert.equal(resolveLanguage("py"), "python");
    assert.equal(resolveLanguage("html"), "xml");
  });

  it("is case-insensitive", () => {
    assert.equal(resolveLanguage("TypeScript"), "typescript");
  });

  it("returns null for an unregistered language and for empty input", () => {
    assert.equal(resolveLanguage("cobol"), null);
    assert.equal(resolveLanguage(null), null);
    assert.equal(resolveLanguage(undefined), null);
  });
});

describe("fileKinds language table stays in sync with the highlight registry", () => {
  it("every mapped extension resolves to a grammar lib/syntax actually registers", () => {
    for (const [extension, language] of Object.entries(LANGUAGE_BY_EXTENSION)) {
      assert.notEqual(
        resolveLanguage(language),
        null,
        `fileKinds maps ".${extension}" to "${language}", which lib/syntax does not register or alias`,
      );
    }
  });
});

describe("highlightToHtml", () => {
  it("wraps recognized tokens in hljs classes for a known language", () => {
    const html = highlightToHtml("const x = 1;", "typescript");
    assert.match(html, /class="hljs-keyword"/);
  });

  it("resolves an alias to the same grammar as its canonical name", () => {
    const viaAlias = highlightToHtml("def f(): pass", "py");
    const viaCanonical = highlightToHtml("def f(): pass", "python");
    assert.equal(viaAlias, viaCanonical);
  });

  it("HTML-escapes source so the result is safe for dangerouslySetInnerHTML", () => {
    const html = highlightToHtml("<script>alert(1)</script>", "xml");
    // The xml grammar tokenizes "<" and "script" into separate spans, so
    // assert on the escape itself rather than a literal "&lt;script&gt;" run.
    assert.doesNotMatch(html, /<script>/);
    assert.match(html, /&lt;/);
    assert.match(html, /&gt;/);
  });

  it("falls back to auto-detection for an unknown language without throwing", () => {
    assert.doesNotThrow(() => highlightToHtml("const x = 1;", "not-a-real-language"));
    assert.doesNotThrow(() => highlightToHtml("const x = 1;", null));
  });

  it("is idempotent across repeated calls (exercises the LRU cache path)", () => {
    const first = highlightToHtml("SELECT * FROM users;", "sql");
    const second = highlightToHtml("SELECT * FROM users;", "sql");
    assert.equal(first, second);
  });
});

describe("fences that should not be painted as code", () => {
  it("honours a language that means plain text", () => {
    const log = "Tests: 12 passed, 0 failed\nBuild complete in 4.2s";

    for (const language of ["text", "plaintext", "txt", "log", "output", "TEXT"]) {
      assert.equal(isPlainLanguage(language), true, language);
      assert.doesNotMatch(highlightToHtml(log, language), /class="hljs-/, language);
    }
  });

  it("still escapes a plain-text fence", () => {
    const html = highlightToHtml("<script>alert(1)</script>", "text");

    assert.doesNotMatch(html, /<script>/);
    assert.match(html, /&lt;script&gt;/);
  });

  it("leaves an unlabeled block alone when auto-detection is not confident", () => {
    // Command output and prose scored 1-2 and came back painted as YAML/CSS:
    // every other word a different hue, which reads as a rendering fault.
    const log = "Tests: 12 passed, 0 failed\nBuild complete in 4.2s\nWarning: nothing to do";

    assert.doesNotMatch(highlightToHtml(log, null), /class="hljs-/);
  });

  it("still auto-detects an unlabeled block that is confidently source", () => {
    const source = "const x = 1;\nfunction f(a) { return a + 1; }\nexport default f;";

    assert.match(highlightToHtml(source, null), /class="hljs-keyword"/);
  });

  it("highlights a diff fence with the diff grammar, not a guess", () => {
    // `- old line` used to auto-detect as a CSS selector; syntax.css already
    // colors hljs-addition/hljs-deletion and had nothing to color.
    const html = highlightToHtml("--- a/f.ts\n+++ b/f.ts\n-old\n+new", "diff");

    assert.equal(resolveLanguage("patch"), "diff");
    assert.match(html, /class="hljs-addition"/);
    assert.match(html, /class="hljs-deletion"/);
  });
});

describe("highlightToHtml on a live fence", () => {
  it("does not auto-detect an unlabeled fence while it streams", () => {
    const code = "function add(a, b) {\n  return a + b;\n}\nconst total = add(1, 2);";
    const live = highlightToHtml(code, null, { live: true });
    assert.doesNotMatch(live, /hljs-/);
    assert.match(highlightToHtml(code, null), /hljs-/);
  });

  it("still highlights a labeled live fence", () => {
    assert.match(highlightToHtml("const x = 1;", "ts", { live: true }), /hljs-keyword/);
  });

  it("escapes live fence text", () => {
    assert.equal(highlightToHtml("<b>&</b>", null, { live: true }), "&lt;b&gt;&amp;&lt;/b&gt;");
  });
});
