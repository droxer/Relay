import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { AgentStreamAccumulator, hasTerminalOutcome, parseAgentStream, segmentKeys } from "../src/lib/agentStream.js";
import { placePermissionAudits } from "../src/lib/permissionAudits.js";

const reply = "当前模型是 **DeepSeek V4.1 Flash Free** ...";
const tool = { type: "tool_use", part: { tool: "tool", state: { status: "completed", input: { code: "..." } } } };
const text = { type: "text", part: { type: "text", text: reply } };
const ndjson = (...events: unknown[]) => events.map((event) => JSON.stringify(event)).join("\n") + "\n";

describe("OpenCode transcript parsing", () => {
  it("keeps ACP messages and reasoning separate while their chunks arrive", () => {
    const chunk = (type: string, messageID: string, text: string) => ({
      type, delta: true, part: { messageID, text },
    });
    const raw = ndjson(
      chunk("reasoning", "thought", "Checking "),
      chunk("reasoning", "thought", "the file."),
      chunk("text", "one", "First "),
      chunk("text", "one", "reply."),
      chunk("text", "two", "Second reply."),
    );
    const accumulator = new AgentStreamAccumulator("opencode");
    for (let end = 1; end < raw.length; end++) {
      assert.deepEqual(accumulator.update(raw.slice(0, end)), parseAgentStream("opencode", raw.slice(0, end)));
    }
    assert.deepEqual(accumulator.update(raw), [
      { kind: "thinking", text: "Checking the file." },
      { kind: "text", text: "First reply." },
      { kind: "text", text: "Second reply." },
    ]);
  });

  it("places approvals by call id while identical calls finish out of order", () => {
    const toolCall = (id: string, status: string) => ({
      type: "tool_use", part: { callID: id, tool: "read", state: { status, input: { path: "config.json" } } },
    });
    const raw = ndjson(toolCall("a", "pending"), toolCall("b", "running"));
    const accumulator = new AgentStreamAccumulator("opencode");
    const running = accumulator.update(raw);
    assert.deepEqual(running, [
      { kind: "tool", id: "a", name: "read", target: "config.json" },
      { kind: "tool", id: "b", name: "read", target: "config.json" },
    ]);
    const completed = accumulator.update(raw + ndjson(toolCall("b", "completed"), toolCall("a", "completed")));
    assert.deepEqual(completed, running);
    const keys = segmentKeys(completed);
    const audit = {
      id: "request-b", toolUseId: "b", toolName: "read", target: "config.json",
      outcome: "allow", tone: "good", label: "Allowed",
    } as const;
    const placement = placePermissionAudits(completed, keys, [audit]);
    assert.equal(placement.bySegment.get(keys[1]!), audit);
    assert.deepEqual(placement.unplaced, []);
  });

  it("keeps a recoverable tool failure visible while the run is still active", () => {
    const raw = ndjson({
      type: "tool_use", part: { tool: "read", state: { status: "error", error: "File missing" } },
    });
    const segments = parseAgentStream("opencode", raw);
    assert.equal(hasTerminalOutcome(segments), false);
    assert.equal(hasTerminalOutcome(parseAgentStream("opencode", raw + ndjson({
      type: "error", error: { message: "Provider disconnected" },
    }))), true);
  });
  it("shows cancelled web searches and blocked fetches without JSON envelopes", () => {
    const raw = ndjson(
      { type: "tool_use", part: { tool: "websearch", state: { status: "error", input: { query: "OpenAI announcement November 4 2026" }, error: JSON.stringify({ metadata: {}, error: "Web search cancelled" }) } } },
      { type: "tool_use", part: { tool: "webfetch", state: { status: "error", input: { url: "https://www.reuters.com/technology/artificial-intelligence/" }, error: JSON.stringify({ metadata: {}, error: "StatusCode: non 2xx status code (401 GET https://www.reuters.com/technology/artificial-intelligence/)" }) } } },
    );
    const expected = [
      { kind: "tool", name: "websearch", target: "OpenAI announcement November 4 2026" },
      { kind: "status", tone: "warn", text: "Web search cancelled.", scope: "tool" },
      { kind: "tool", name: "webfetch", target: "https://www.reuters.com/technology/artificial-intelligence/" },
      { kind: "status", tone: "bad", text: "This website requires authentication (HTTP 401). Try another source.", scope: "tool" },
    ];
    assert.deepEqual(parseAgentStream("opencode", raw), expected);
    const accumulator = new AgentStreamAccumulator("opencode");
    for (let end = 1; end <= raw.length; end++) {
      assert.deepEqual(accumulator.update(raw.slice(0, end)), parseAgentStream("opencode", raw.slice(0, end)));
    }
    assert.deepEqual(accumulator.update(raw), expected);
  });

  it("grows one text block across deltas without trimming Markdown whitespace", () => {
    const accumulator = new AgentStreamAccumulator("opencode");
    let raw = "";
    let expected = "";
    for (const chunk of ["Hello", " ", "**world**", "\n\n", "```ts\n", "  const x = 1;\n", "```", " 👨‍👩‍👧‍👦"]) {
      raw += ndjson({ type: "text", delta: true, part: { type: "text", text: chunk } });
      expected += chunk;
      assert.deepEqual(parseAgentStream("opencode", raw), [{ kind: "text", text: expected }]);
      assert.deepEqual(accumulator.update(raw), [{ kind: "text", text: expected }]);
    }
    const before = accumulator.update(raw)[0];
    raw += ndjson(tool, { type: "text", delta: true, part: { type: "text", text: "Done." } });
    assert.deepEqual(accumulator.update(raw), [
      { kind: "text", text: expected }, { kind: "tool", name: "tool" }, { kind: "text", text: "Done." },
    ]);
    assert.equal(accumulator.update(raw)[0], before);
    assert.deepEqual(accumulator.update(ndjson(text)), [{ kind: "text", text: reply }]);
  });

  it("handles fragmented delta records, repeated updates, and replaced logs", () => {
    const raw = ndjson(
      { type: "text", delta: true, part: { text: "Hello " } },
      { type: "text", delta: true, part: { text: "世界\n\n" } },
      tool,
      { type: "text", delta: true, part: { text: "Done." } },
    );
    const accumulator = new AgentStreamAccumulator("opencode");
    for (let end = 1; end <= raw.length; end++) {
      const prefix = raw.slice(0, end);
      const segments = accumulator.update(prefix);
      assert.deepEqual(segments, parseAgentStream("opencode", prefix));
      assert.equal(accumulator.update(prefix), segments);
    }
    assert.deepEqual(accumulator.update(ndjson({ type: "text", delta: true, part: { text: "New run" } })), [
      { kind: "text", text: "New run" },
    ]);
    assert.deepEqual(accumulator.update(""), []);
  });

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
      { kind: "status", tone: "bad", text: "denied", scope: "tool" },
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
      { kind: "status", tone: "bad", text: "Command failed", scope: "tool" },
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
