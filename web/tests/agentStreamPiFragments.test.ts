import assert from "node:assert/strict";
import { test } from "node:test";
import { AgentStreamAccumulator, parseAgentStream } from "../src/lib/agentStream.js";
import { streamRecords } from "../src/lib/agent-stream/records.js";

// A completed-run tail can begin inside the assistant's JSON string, before
// the frame's `type` field. These are protocol fragments, not plain replies.
const clipped = '我是 Jack。\\n- 读代码、做验证。","index":0}],"api":"anthropic-messages","provider":"minimax-cn","model":"MiniMax-M3.1-Flash","usage":{"input":42},"stopReason":"stop","timestamp":1794327149672,"responseId":"response_1"}},"message":';
const reply = JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "你好！我是 Jack。" }] } });

test("Pi thread rendering hides clipped protocol tails and recovers the following reply", () => {
  const raw = `${clipped}\n${reply}\n`;
  const expected = [{ kind: "text", text: "你好！我是 Jack。" }];
  assert.deepEqual(parseAgentStream("pi", raw), expected);
  const accumulator = new AgentStreamAccumulator("pi");
  assert.deepEqual(accumulator.update(`${clipped}\n`), []);
  for (let end = clipped.length + 1; end <= raw.length; end++) {
    assert.deepEqual(accumulator.update(raw.slice(0, end)), parseAgentStream("pi", raw.slice(0, end)));
  }
  assert.deepEqual(accumulator.update(raw), expected);
});

test("Pi preserves JSON deliberately written in an assistant text block", () => {
  const text = '{"api":"example","model":"demo"}';
  assert.deepEqual(parseAgentStream("pi", JSON.stringify({
    type: "message_update", assistantMessageEvent: { type: "text_delta", delta: text },
  })), [{ kind: "text", text }]);
  assert.deepEqual(parseAgentStream("pi", "Values: [1, 2]"), [{ kind: "text", text: "Values: [1, 2]" }]);
});

test("Pi hides truncated metadata values and orphaned closing delimiters", () => {
  const metadata = '"api":"anthropic-messages","provider":"minimax-cn","usage":{"input":42},"stopReason":"stop","timestamp":1794327149672,"responseId":"response_1"}}';
  for (let offset = 0; offset < metadata.length; offset++) {
    assert.deepEqual(parseAgentStream("pi", `${metadata.slice(offset)}\n${reply}\n`),
      [{ kind: "text", text: "你好！我是 Jack。" }], `offset ${offset}`);
  }
});

test("Pi hides clipped tool-result frames ending in a boolean or null", () => {
  for (const isError of [false, true, null]) {
    const tool = JSON.stringify({ type: "tool_execution_end", toolCallId: "call_1", toolName: "bash",
      result: { content: [{ type: "text", text: "ok" }] }, isError });
    for (let offset = 1; offset < tool.length; offset++) {
      assert.deepEqual(parseAgentStream("pi", `${tool.slice(offset)}\n${reply}\n`),
        [{ kind: "text", text: "你好！我是 Jack。" }], `offset ${offset}, isError ${isError}`);
    }
  }
});

test("Pi hides clipped top-level string errors", () => {
  for (const event of [
    { type: "auto_retry_end", success: false, finalError: 'after retry\nfailed with {braces} and "quotes"' },
    { type: "error", message: 'after retry\nfailed with {braces} and "quotes"' },
  ]) {
    const frame = JSON.stringify(event);
    for (let offset = 1; offset < frame.length; offset++) {
      assert.deepEqual(parseAgentStream("pi", `${frame.slice(offset)}\n${reply}\n`),
        [{ kind: "text", text: "你好！我是 Jack。" }], `offset ${offset}`);
    }
  }
});

test("Pi keeps plain diagnostics and shared framing preserves other runtimes' prose", () => {
  for (const text of ['Use "api": to select the endpoint.', 'The character } closes the object.', '"Error": permission denied']) {
    assert.deepEqual(parseAgentStream("pi", text), [{ kind: "text", text }]);
    assert.equal(streamRecords(text)[0]?.kind, "text");
  }
});

test("Pi recovers at a JSONL boundary when clipped content contains unmatched braces", () => {
  const raw = `old text with {braces inside", "api":"x"}}\n${reply}\n`;
  assert.deepEqual(parseAgentStream("pi", raw), [{ kind: "text", text: "你好！我是 Jack。" }]);
  const accumulator = new AgentStreamAccumulator("pi");
  assert.deepEqual(accumulator.update(raw), parseAgentStream("pi", raw));
});

test("Pi does not flash escaped protocol text while a clipped line arrives", () => {
  const accumulator = new AgentStreamAccumulator("pi");
  for (let end = 1; end <= clipped.length; end++) {
    for (const segment of accumulator.update(clipped.slice(0, end))) {
      if (segment.kind === "text") assert.doesNotMatch(segment.text, /\\|"index"|"api"|"provider"/);
    }
  }
});
