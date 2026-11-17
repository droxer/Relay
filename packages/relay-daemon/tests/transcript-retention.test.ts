import assert from "node:assert/strict";
import test from "node:test";
import { BoundedTextCapture } from "../src/bounded-text.js";
import { initialAgentState, runAgentNode } from "relay-core";

const limit = 262_144;
const first = JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "FIRST-REPLY-MARKER" } });
const last = JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "FINAL-REPLY-MARKER" } });
const middle = JSON.stringify({ type: "item.completed", item: { type: "reasoning", text: "x".repeat(500) } });
const output = [first, ...Array(900).fill(middle), last, ""].join("\n");

function verifyTranscript(text: string, cap = limit): void {
  assert.ok(text.length <= cap);
  assert.ok(text.includes(first), "the opening response must survive capture");
  assert.ok(text.includes(last), "the final response must survive capture");
  assert.match(text, /omitted/i);
  for (const line of text.trim().split("\n")) {
    if (/omitted/i.test(line)) continue;
    assert.doesNotThrow(() => JSON.parse(line), "retained JSONL frames must remain complete");
  }
}

test("completed agent logs preserve opening and final replies beyond the cap", async () => {
  const patch = await runAgentNode("codex", initialAgentState("Check transcript"), {
    execStream: async () => ({ exit_code: 0, stdout: output, stderr: "" }),
  });
  verifyTranscript(patch.agent_logs![0]!.split("stdout:\n")[1]!);
});

for (const chunkSize of [1, 701, output.length]) {
  test(`bounded process capture preserves JSONL boundaries with ${chunkSize}-character chunks`, () => {
    const capture = new BoundedTextCapture(limit);
    for (let i = 0; i < output.length; i += chunkSize) capture.append(output.slice(i, i + chunkSize));
    verifyTranscript(capture.toString());
    assert.equal(capture.toString(), capture.toString(), "reading capture must not mutate it");
  });
}

test("bounded capture leaves output at or below the limit unchanged", () => {
  for (const value of ["", "short", "x".repeat(limit)]) {
    const capture = new BoundedTextCapture(limit);
    capture.append(value);
    assert.equal(capture.toString(), value);
  }
});

test("a single oversized JSONL frame is omitted rather than emitting broken JSON", () => {
  const capture = new BoundedTextCapture(1024);
  capture.append(first + "\n" + JSON.stringify({ type: "tool", text: "x".repeat(10_000) }) + "\n" + last + "\n");
  verifyTranscript(capture.toString(), 1024);
});
