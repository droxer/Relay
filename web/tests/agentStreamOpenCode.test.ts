import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { AgentStreamAccumulator, parseAgentStream } from "../src/lib/agentStream.js";

const reply = "当前模型是 **DeepSeek V4.1 Flash Free** ...";
const tool = { type: "tool_use", part: { tool: "tool", state: { status: "completed", input: { code: "..." } } } };
const text = { type: "text", part: { type: "text", text: reply } };
const ndjson = (...events: unknown[]) => events.map((event) => JSON.stringify(event)).join("\n") + "\n";

describe("OpenCode transcript parsing", () => {
  it("renders tool calls and Markdown text from the reported NDJSON", () => {
    assert.deepEqual(parseAgentStream("opencode", ndjson(tool, text)), [
      { kind: "tool", name: "tool" },
      { kind: "text", text: reply },
    ]);
  });

  it("keeps completed tool targets and hides step bookkeeping and tool output", () => {
    assert.deepEqual(parseAgentStream("opencode", ndjson(
      { type: "step_start", part: { type: "step-start" } },
      { type: "tool_use", part: { tool: "bash", state: { status: "running" } } },
      { type: "tool_use", part: { tool: "bash", state: { status: "completed", title: "Check files", input: { command: "ls\npwd" }, output: "private tool output" } } },
      { type: "step_finish", part: { tokens: { input: 3, output: 1 } } },
    )), [{ kind: "tool", name: "bash", target: "ls" }]);
  });

  it("uses a tool title when its input has no recognized target", () => {
    assert.deepEqual(parseAgentStream("opencode", ndjson(
      { type: "tool_use", part: { tool: "tool", state: { status: "completed", title: "Inspect project" } } },
    )), [{ kind: "tool", name: "tool", target: "Inspect project" }]);
  });

  it("reads OpenCode file paths and skips a title that only repeats the tool name", () => {
    assert.deepEqual(parseAgentStream("opencode", ndjson(
      { type: "tool_use", part: { tool: "read", state: { status: "completed", title: "read", input: { filePath: "/repo/src/app.ts" } } } },
      { type: "tool_use", part: { tool: "edit", state: { status: "completed", title: "edit", input: { oldString: "a" } } } },
    )), [
      { kind: "tool", name: "read", target: "/repo/src/app.ts" },
      { kind: "tool", name: "edit" },
    ]);
  });

  it("falls back to output for a failed tool from an older ACP adapter", () => {
    assert.deepEqual(parseAgentStream("opencode", ndjson(
      { type: "tool_use", part: { tool: "shell", state: { status: "error", input: { command: "rm x" }, output: "  denied\n" } } },
    )), [
      { kind: "tool", name: "shell", target: "rm x" },
      { kind: "status", tone: "bad", text: "denied" },
    ]);
  });

  it("renders reasoning as thinking and trims text parts", () => {
    assert.deepEqual(parseAgentStream("opencode", ndjson(
      { type: "reasoning", part: { type: "reasoning", text: "  Check the model.  " } },
      { type: "text", part: { type: "text", text: "\n\nAnswer.\n" } },
      { type: "reasoning", part: { type: "reasoning", text: "   " } },
    )), [
      { kind: "thinking", text: "Check the model." },
      { kind: "text", text: "Answer." },
    ]);
  });

  it("shows failed tools and turn errors without leaking JSON", () => {
    assert.deepEqual(parseAgentStream("opencode", ndjson(
      { type: "tool_use", part: { tool: "bash", state: { status: "error", input: { command: "npm test" }, error: "Command failed" } } },
      { type: "error", error: { message: "Provider unavailable" } },
    )), [
      { kind: "tool", name: "bash", target: "npm test" },
      { kind: "status", tone: "bad", text: "Command failed" },
      { kind: "status", tone: "bad", text: "OpenCode error: Provider unavailable" },
    ]);
  });

  it("tolerates empty and malformed parts and keeps plain output", () => {
    assert.deepEqual(parseAgentStream("opencode", "plain words\n" + ndjson(
      { type: "text" }, { type: "text", part: { text: 3 } },
      { type: "tool_use", part: null }, { type: "unknown" },
    )), [{ kind: "text", text: "plain words" }]);
  });

  it("hides incomplete JSON while streaming and renders each completed event once", () => {
    const raw = ndjson(tool, text);
    const accumulator = new AgentStreamAccumulator("opencode");
    for (let end = 1; end <= raw.length; end += 1) {
      const segments = accumulator.update(raw.slice(0, end));
      assert.deepEqual(segments, parseAgentStream("opencode", raw.slice(0, end)));
      assert.ok(segments.every((segment) => segment.kind === "tool"
        || (segment.kind === "text" && segment.text === reply)));
    }
    assert.deepEqual(accumulator.update(raw), [{ kind: "tool", name: "tool" }, { kind: "text", text: reply }]);
    assert.deepEqual(accumulator.update(ndjson(text)), [{ kind: "text", text: reply }]);
  });
});
