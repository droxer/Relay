import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { OutputEventBuffer } from "../src/output-event-buffer.js";

describe("OutputEventBuffer", () => {
  it("coalesces adjacent chunks from the same stream", () => {
    const emitted: Array<Array<{ stream: "stdout" | "stderr"; text: string }>> = [];
    const buffer = new OutputEventBuffer((entries) => emitted.push(entries), {
      delayMs: 1_000,
      maxChars: 32_768,
    });

    buffer.push("stdout", "one");
    buffer.push("stdout", " two");
    buffer.flush();

    assert.deepEqual(emitted, [[{ stream: "stdout", text: "one two" }]]);
    buffer.close();
  });

  it("bounds emissions when stdout and stderr alternate", () => {
    const emitted: Array<Array<{ stream: "stdout" | "stderr"; text: string }>> = [];
    const buffer = new OutputEventBuffer((entries) => emitted.push(entries), {
      delayMs: 1_000,
      maxChars: 32_768,
    });

    buffer.push("stdout", "out-1");
    buffer.push("stderr", "err");
    buffer.push("stdout", "out-2");
    buffer.flush();

    assert.deepEqual(emitted, [[
      { stream: "stdout", text: "out-1" },
      { stream: "stderr", text: "err" },
      { stream: "stdout", text: "out-2" },
    ]]);
    buffer.close();
  });

  it("flushes immediately at the bounded character budget", () => {
    const emitted: string[] = [];
    const buffer = new OutputEventBuffer((entries) => emitted.push(entries.map((entry) => entry.text).join("")), {
      delayMs: 1_000,
      maxChars: 5,
    });

    buffer.push("stdout", "hello");

    assert.deepEqual(emitted, ["hello"]);
    buffer.close();
  });

  it("splits a single oversized renderer chunk at the character budget", () => {
    const emitted: string[] = [];
    const buffer = new OutputEventBuffer((entries) => emitted.push(entries.map((entry) => entry.text).join("")), {
      delayMs: 1_000,
      maxChars: 5,
    });

    buffer.push("stdout", "abcdefghij");

    assert.deepEqual(emitted, ["abcde", "fghij"]);
    buffer.close();
  });

  it("never splits a Unicode surrogate pair across batches", () => {
    const emitted: string[] = [];
    const buffer = new OutputEventBuffer((entries) => emitted.push(entries.map((entry) => entry.text).join("")), {
      delayMs: 1_000,
      maxChars: 3,
    });

    buffer.push("stdout", "ab😀cd");
    buffer.close();

    assert.equal(emitted.join(""), "ab😀cd");
    assert.equal(emitted.some((text) => /[\uD800-\uDBFF]$|^[\uDC00-\uDFFF]/u.test(text)), false);
  });

  it("holds the timed flush while delivery is busy and releases one coalesced batch", async () => {
    const emitted: string[] = [];
    let busy = true;
    const buffer = new OutputEventBuffer((entries) => emitted.push(entries.map((entry) => entry.text).join("")), {
      delayMs: 5,
      maxChars: 32_768,
      isBusy: () => busy,
    });

    buffer.push("stdout", "one ");
    await new Promise((resolve) => setTimeout(resolve, 20));
    buffer.push("stdout", "two");
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(emitted, []);

    busy = false;
    buffer.resume();
    assert.deepEqual(emitted, ["one two"]);
    buffer.resume();
    assert.deepEqual(emitted, ["one two"]);
    buffer.close();
  });

  it("still flushes at the size cap while delivery is busy", () => {
    const emitted: string[] = [];
    const buffer = new OutputEventBuffer((entries) => emitted.push(entries.map((entry) => entry.text).join("")), {
      delayMs: 1_000,
      maxChars: 4,
      isBusy: () => true,
    });

    buffer.push("stdout", "abcdef");
    assert.deepEqual(emitted, ["abcd"]);
    buffer.close();
    assert.deepEqual(emitted, ["abcd", "ef"]);
  });

  it("flushes after the latency window", async () => {
    const emitted: string[] = [];
    const buffer = new OutputEventBuffer((entries) => emitted.push(entries.map((entry) => entry.text).join("")), {
      delayMs: 5,
      maxChars: 32_768,
    });

    buffer.push("stdout", "live");
    await new Promise((resolve) => setTimeout(resolve, 20));

    assert.deepEqual(emitted, ["live"]);
    buffer.close();
  });
});
