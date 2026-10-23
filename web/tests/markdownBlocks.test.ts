import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createMarkdownBlockSplitter, splitMarkdownBlocks } from "../src/lib/markdownBlocks.ts";

function roundTrips(text: string): string[] {
  const blocks = splitMarkdownBlocks(text);
  assert.equal(blocks.join(""), text, "blocks must concatenate back to the input");
  return blocks;
}

describe("splitMarkdownBlocks", () => {
  it("returns no blocks for empty input", () => {
    assert.deepEqual(splitMarkdownBlocks(""), []);
  });

  it("keeps a single paragraph whole", () => {
    assert.deepEqual(roundTrips("hello\nworld"), ["hello\nworld"]);
  });

  it("splits top-level paragraphs at blank lines, keeping the blank line with the earlier block", () => {
    assert.deepEqual(roundTrips("one\n\ntwo\n\n\nthree"), ["one\n\n", "two\n\n\n", "three"]);
  });

  it("splits headings from the prose after them", () => {
    assert.deepEqual(roundTrips("# Title\n\nBody text"), ["# Title\n\n", "Body text"]);
  });

  it("never splits inside a backtick fence", () => {
    const text = "intro\n\n```js\nconst a = 1;\n\nconst b = 2;\n```\n\nafter";
    assert.deepEqual(roundTrips(text), ["intro\n\n", "```js\nconst a = 1;\n\nconst b = 2;\n```\n\n", "after"]);
  });

  it("never splits inside a tilde fence, and a backtick line does not close it", () => {
    const text = "~~~\n```\n\nstill code\n~~~\n\nafter";
    assert.deepEqual(roundTrips(text), ["~~~\n```\n\nstill code\n~~~\n\n", "after"]);
  });

  it("needs a closing fence at least as long as the opening one", () => {
    const text = "````\n```\n\ninner\n````\n\nafter";
    assert.deepEqual(roundTrips(text), ["````\n```\n\ninner\n````\n\n", "after"]);
  });

  it("keeps an unclosed fence and everything after it in the last block", () => {
    const text = "intro\n\n```py\nprint(1)\n\n\nprint(2)";
    assert.deepEqual(roundTrips(text), ["intro\n\n", "```py\nprint(1)\n\n\nprint(2)"]);
  });

  it("never splits inside a $$ math block", () => {
    const text = "intro\n\n$$\na = b\n\nc = d\n$$\n\nafter";
    assert.deepEqual(roundTrips(text), ["intro\n\n", "$$\na = b\n\nc = d\n$$\n\n", "after"]);
  });

  it("treats a one-line $$…$$ as closed", () => {
    assert.deepEqual(roundTrips("$$x^2$$\n\nafter"), ["$$x^2$$\n\n", "after"]);
  });

  it("keeps an unclosed $$ block in the last block", () => {
    assert.deepEqual(roundTrips("intro\n\n$$\na\n\nb"), ["intro\n\n", "$$\na\n\nb"]);
  });

  it("does not count $$ inside a code fence", () => {
    const text = "```\n$$\n```\n\nafter";
    assert.deepEqual(roundTrips(text), ["```\n$$\n```\n\n", "after"]);
  });

  it("keeps a loose list together", () => {
    const text = "- one\n\n- two\n\n1. three\n\n2. four";
    assert.deepEqual(roundTrips(text), [text]);
  });

  it("keeps an indented list continuation with its item", () => {
    const text = "- item\n\n  continued paragraph\n\n      code in item\n\nafter";
    assert.deepEqual(roundTrips(text), ["- item\n\n  continued paragraph\n\n      code in item\n\n", "after"]);
  });

  it("splits after a list once unindented prose follows", () => {
    assert.deepEqual(roundTrips("- a\n- b\n\nprose"), ["- a\n- b\n\n", "prose"]);
  });

  it("keeps a fence inside a list item together", () => {
    const text = "1. step\n\n   ```sh\n   ls\n\n   pwd\n   ```\n\n2. next";
    assert.deepEqual(roundTrips(text), [text]);
  });

  it("splits between separate blockquotes but not inside one", () => {
    const text = "> a\n>\n> b\n\n> c\n\nafter";
    assert.deepEqual(roundTrips(text), ["> a\n>\n> b\n\n", "> c\n\n", "after"]);
  });

  it("returns one block when the text has link reference definitions", () => {
    const text = "See [the docs][docs].\n\nMore text.\n\n[docs]: https://example.com";
    assert.deepEqual(splitMarkdownBlocks(text), [text]);
  });

  it("returns one block when the text has footnote definitions", () => {
    const text = "Claim[^1].\n\nMore.\n\n[^1]: Source.";
    assert.deepEqual(splitMarkdownBlocks(text), [text]);
  });

  it("does not mistake a reference-looking line inside a fence for a definition", () => {
    const text = "```\n[x]: y\n```\n\nafter";
    assert.deepEqual(roundTrips(text), ["```\n[x]: y\n```\n\n", "after"]);
  });

  it("handles CRLF line endings", () => {
    const text = "one\r\n\r\n```\r\na\r\n\r\nb\r\n```\r\n\r\ntwo";
    assert.deepEqual(roundTrips(text), ["one\r\n\r\n", "```\r\na\r\n\r\nb\r\n```\r\n\r\n", "two"]);
  });

  it("keeps an HTML comment spanning blank lines together", () => {
    const text = "<!--\nnote\n\nmore\n-->\n\nafter";
    assert.deepEqual(roundTrips(text), ["<!--\nnote\n\nmore\n-->\n\n", "after"]);
  });

  it("keeps raw pre/script/style/textarea HTML blocks spanning blank lines together", () => {
    // CommonMark HTML block type 1 runs to its closing tag, blank lines included.
    for (const tag of ["pre", "script", "style", "textarea", "PRE"]) {
      const text = `<${tag}>\nfoo\n\nbar\n</${tag}>\n\nafter`;
      assert.deepEqual(roundTrips(text), [`<${tag}>\nfoo\n\nbar\n</${tag}>\n\n`, "after"]);
    }
    assert.deepEqual(roundTrips("<pre>one line</pre>\n\nafter"), ["<pre>one line</pre>\n\n", "after"]);
  });

  it("leaves trailing blank lines in the last block", () => {
    assert.deepEqual(roundTrips("one\n\ntwo\n\n"), ["one\n\n", "two\n\n"]);
  });

  it("keeps earlier blocks stable as a streamed prefix grows", () => {
    const full = "# Plan\n\nFirst paragraph.\n\n```ts\nconst x = 1;\n\nconst y = 2;\n```\n\nClosing words.";
    const settled = splitMarkdownBlocks(full);
    for (let end = 1; end <= full.length; end += 1) {
      const blocks = roundTrips(full.slice(0, end));
      // Every block but the last is final: it matches the fully streamed split.
      blocks.slice(0, -1).forEach((block, index) => assert.equal(block, settled[index]));
    }
  });
});

describe("createMarkdownBlockSplitter", () => {
  const reply = [
    "# Plan\n\n",
    "First we look.\n\n",
    "- one\n- two\n\n",
    "```ts\nconst a = 1;\n\nconst b = 2;\n```\n\n",
    "$$\nx = 1\n\ny = 2\n$$\n\n",
    "Closing words.",
  ].join("");

  it("splits every streamed prefix exactly as a fresh scan would", () => {
    const splitter = createMarkdownBlockSplitter();
    for (let length = 1; length <= reply.length; length += 1) {
      const prefix = reply.slice(0, length);
      assert.deepEqual(splitter.split(prefix), splitMarkdownBlocks(prefix), `prefix of ${length}`);
    }
  });

  it("resumes at the open line instead of rescanning the reply", () => {
    const splitter = createMarkdownBlockSplitter();
    const settled = "# Plan\n\nFirst we look.\n\nSecond, we";
    splitter.split(settled);
    const before = splitter.scannedChars;
    splitter.split(`${settled} act.`);
    // Only the line that had not ended ("Second, we act.") is read again.
    assert.equal(splitter.scannedChars - before, "Second, we act.".length);
  });

  it("rescans from the start when the text is not an extension of the last", () => {
    const splitter = createMarkdownBlockSplitter();
    splitter.split("one\n\ntwo\n\nthr");
    const rewritten = "alpha\n\nbeta";
    const before = splitter.scannedChars;
    assert.deepEqual(splitter.split(rewritten), splitMarkdownBlocks(rewritten));
    assert.equal(splitter.scannedChars - before, rewritten.length);
  });

  it("forgets everything on empty text and starts again", () => {
    const splitter = createMarkdownBlockSplitter();
    splitter.split("one\n\ntwo");
    assert.deepEqual(splitter.split(""), []);
    assert.deepEqual(splitter.split("- a\n\n- b"), ["- a\n\n- b"]);
  });

  it("merges a boundary back when the open line turns out to continue the list", () => {
    const splitter = createMarkdownBlockSplitter();
    assert.deepEqual(splitter.split("- a\n\n2"), ["- a\n\n", "2"]);
    assert.deepEqual(splitter.split("- a\n\n2. b"), ["- a\n\n2. b"]);
  });

  it("collapses to one block once a definition settles, and stays there", () => {
    const splitter = createMarkdownBlockSplitter();
    assert.deepEqual(splitter.split("para\n\nnext"), ["para\n\n", "next"]);
    assert.deepEqual(splitter.split("para\n\nnext\n\n[x]: http://e"), ["para\n\nnext\n\n[x]: http://e"]);
    // The definition's line ends here, so it settles; after that the answer
    // needs no scan at all.
    assert.deepEqual(splitter.split("para\n\nnext\n\n[x]: http://e\n\nmore"), ["para\n\nnext\n\n[x]: http://e\n\nmore"]);
    const before = splitter.scannedChars;
    assert.deepEqual(splitter.split("para\n\nnext\n\n[x]: http://e\n\nmore words"), ["para\n\nnext\n\n[x]: http://e\n\nmore words"]);
    assert.equal(splitter.scannedChars, before, "a settled definition answers without scanning");
  });
});
