import assert from "node:assert/strict";
import { test } from "node:test";
import { PiStreamRenderer } from "../src/renderers.js";

test("Pi terminal streaming hides clipped protocol tails and resumes at the next frame", () => {
  const renderer = new PiStreamRenderer();
  const clipped = '我是 Jack。\\n- 做验证。","index":0}],"api":"anthropic-messages","provider":"minimax-cn","usage":{"input":42},"stopReason":"stop"}}';
  const raw = `${clipped}\n${JSON.stringify({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "你好！我是 Jack。" } })}\n`;
  let output = "";
  for (let i = 0; i < raw.length; i += 7) output += renderer.feed(raw.slice(i, i + 7));
  assert.match(output, /你好！我是 Jack。/);
  assert.doesNotMatch(output, /"api"|"provider"|"usage"|"index"|\\n/);
});

test("Pi terminal rendering hides truncated values but keeps plain output and assistant JSON", () => {
  for (const fragment of ['response_1"}}', '1794327149672}}', '}}']) {
    assert.equal(new PiStreamRenderer().feed(`${fragment}\n`), "");
  }
  assert.match(new PiStreamRenderer().feed("A plain Pi reply.\n"), /A plain Pi reply\./);
  assert.match(new PiStreamRenderer().feed("Values: [1, 2]\n"), /Values: \[1, 2\]/);
  const text = '{"api":"example","model":"demo"}';
  assert.match(new PiStreamRenderer().feed(`${JSON.stringify({
    type: "message_update", assistantMessageEvent: { type: "text_delta", delta: text },
  })}\n`), /\{"api":"example","model":"demo"\}/);
});

test("Pi terminal preserves ordinary diagnostics and quoted prose", () => {
  for (const text of ['Use "api": to select the endpoint.', 'The character } closes the object.', '"Error": permission denied']) {
    assert.ok(new PiStreamRenderer().feed(`${text}\n`).includes(text));
  }
});

test("Pi terminal hides clipped tool-result frames with scalar endings", () => {
  for (const isError of [false, true, null]) {
    const frame = JSON.stringify({ type: "tool_execution_end", toolCallId: "call_1", toolName: "bash",
      result: { content: [{ type: "text", text: "ok" }] }, isError });
    for (let offset = 1; offset < frame.length; offset++) {
      assert.equal(new PiStreamRenderer().feed(`${frame.slice(offset)}\n`), "", `offset ${offset}, isError ${isError}`);
    }
  }
});

test("Pi terminal hides clipped string error fields", () => {
  const frame = JSON.stringify({ type: "auto_retry_end", success: false,
    finalError: 'after retry\nfailed with {braces} and "quotes"' });
  for (let offset = 1; offset < frame.length; offset++) {
    assert.equal(new PiStreamRenderer().feed(`${frame.slice(offset)}\n`), "", `offset ${offset}`);
  }
});
