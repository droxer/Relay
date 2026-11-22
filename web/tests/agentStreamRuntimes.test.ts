import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { stripVTControlCharacters } from "node:util";
import { CodexStreamRenderer, OpenCodeStreamRenderer, PiStreamRenderer } from "relay-core";

import {
  AgentStreamAccumulator,
  displayAgentStreamSegments,
  hasTerminalOutcome,
  parseAgentStream,
  type AgentSegment,
} from "../src/lib/agentStream.js";
import type { AgentName } from "../src/types.js";

// Every runtime in both of its launch modes: the plain headless CLI, and the
// permission-bridged launch (claude-mcp, codex-app-server, opencode-acp,
// pi-extension) a `native`-policy local run uses. The fixtures are trimmed
// from real daemon run logs (`~/.relay/daemon-nodes/<id>/logs/<runId>.jsonl`,
// the "agent output" stdout entries in sequence order), keeping each frame's
// real shape and dropping only bulk (usage, long text, signatures).

const jsonl = (events: readonly Record<string, unknown>[]): string =>
  events.map((event) => `${JSON.stringify(event)}\n`).join("");

/** Feeds the raw log through the accumulator in small slices, as SSE delivers it. */
function streamed(agent: AgentName, raw: string, step = 97): AgentSegment[] {
  const accumulator = new AgentStreamAccumulator(agent);
  let segments: AgentSegment[] = [];
  for (let end = step; end < raw.length + step; end += step) {
    segments = accumulator.update(raw.slice(0, Math.min(end, raw.length)));
  }
  return segments;
}

function assertRendersTranscript(agent: AgentName, raw: string): AgentSegment[] {
  const segments = streamed(agent, raw);
  assert.deepEqual(segments, parseAgentStream(agent, raw), "streamed parse must match the whole-log parse");
  const shown = displayAgentStreamSegments(segments, [], false).segments;
  assert.ok(shown.length > 0, "a finished run never shows an empty transcript");
  for (const segment of segments) {
    assert.notEqual(segment.kind, "raw", `no unclassified output: ${JSON.stringify(segment)}`);
    if (segment.kind === "text" || segment.kind === "thinking") {
      assert.doesNotMatch(segment.text, /"type"\s*:|^\s*\{"/, "no raw JSON reaches the transcript");
    }
  }
  return segments;
}

const tools = (segments: AgentSegment[]) =>
  segments.flatMap((segment) => segment.kind === "tool" ? [`${segment.name} ${segment.target ?? ""}`.trim()] : []);
const commands = (segments: AgentSegment[]) =>
  segments.flatMap((segment) => segment.kind === "command" ? [segment.command] : []);
const texts = (segments: AgentSegment[], kind: "text" | "thinking" = "text") =>
  segments.flatMap((segment) => segment.kind === kind ? [segment.text] : []);

// ---------------------------------------------------------------- Claude

const CLAUDE_SESSION = { session_id: "ea97ee2e", parent_tool_use_id: null };
const claudeStream = (msg: string, event: Record<string, unknown>) =>
  ({ type: "stream_event", event, ...CLAUDE_SESSION, api_message_id: msg });
const claudeAssistant = (msg: string, content: unknown[]) =>
  ({ type: "assistant", message: { model: "claude-haiku-5-5", id: msg, type: "message", role: "assistant", content, stop_reason: null }, ...CLAUDE_SESSION });
const claudeToolResult = (id: string, content: string, meta?: Record<string, unknown>) => ({
  type: "user",
  message: { role: "user", content: [{ tool_use_id: id, type: "tool_result", content, is_error: Boolean(meta && meta.decision === "reject") }] },
  ...CLAUDE_SESSION,
  ...(meta ? { tool_result_meta: [{ id, permission_decision: meta }] } : {}),
});

function claudeRun({ bridged }: { bridged: boolean }): string {
  const bash = { command: "git status --short --branch && git log --oneline -12", description: "Check branch and recent commits" };
  const ask = { questions: [{ question: "Which summary should I keep?", header: "Summary", options: [{ label: "Short" }, { label: "Long" }], multiSelect: false }] };
  return jsonl([
    { type: "system", subtype: "hook_started", hook_name: "SessionStart:startup", ...CLAUDE_SESSION },
    { type: "system", subtype: "init", cwd: "/workspace", tools: ["Task", "AskUserQuestion", "Bash"], permissionMode: "default", ...CLAUDE_SESSION },
    { type: "system", subtype: "status", status: "requesting", ...CLAUDE_SESSION },
    claudeStream("msg_1", { type: "message_start", message: { id: "msg_1", type: "message", role: "assistant", content: [] } }),
    // `thinking_display: "updates"` streams token estimates, never the text.
    { ...claudeStream("msg_1", { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } }), thinking_display: "updates" },
    { type: "system", subtype: "thinking_tokens", estimated_tokens: 50, estimated_tokens_delta: 50, ...CLAUDE_SESSION },
    claudeStream("msg_1", { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "", estimated_tokens: 50 } }),
    claudeStream("msg_1", { type: "content_block_delta", index: 0, delta: { type: "signature_delta" } }),
    claudeAssistant("msg_1", [{ type: "thinking", thinking: "", signature: "sig" }]),
    claudeStream("msg_1", { type: "content_block_stop", index: 0 }),
    claudeStream("msg_1", { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "toolu_1", name: "Bash", input: {}, caller: { type: "direct" } } }),
    claudeStream("msg_1", { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: "" } }),
    claudeStream("msg_1", { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: JSON.stringify(bash) } }),
    claudeAssistant("msg_1", [{ type: "tool_use", id: "toolu_1", name: "Bash", input: bash, caller: { type: "direct" } }]),
    claudeStream("msg_1", { type: "content_block_stop", index: 1 }),
    // A bridged run carries who decided the call; a person approved this one.
    claudeToolResult("toolu_1", "## main...origin/main\neace3c03 Merge pull request #513", bridged ? { decision: "accept", source: "user_temporary" } : undefined),
    claudeStream("msg_1", { type: "message_delta", delta: { stop_reason: "tool_use" } }),
    claudeStream("msg_1", { type: "message_stop" }),
    { type: "rate_limit_event", rate_limit_info: { status: "allowed" }, ...CLAUDE_SESSION },
    ...(bridged
      ? [
          // The runtime's own "ask the user" tool, answered through the broker,
          // then a call the person denied: both are ordinary tool frames.
          claudeStream("msg_2", { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "toolu_2", name: "AskUserQuestion", input: {} } }),
          claudeStream("msg_2", { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify(ask) } }),
          claudeAssistant("msg_2", [{ type: "tool_use", id: "toolu_2", name: "AskUserQuestion", input: ask }]),
          claudeStream("msg_2", { type: "content_block_stop", index: 0 }),
          claudeToolResult("toolu_2", "User has answered your questions: \"Which summary should I keep?\"=\"Short\".", { decision: "accept", source: "user_temporary" }),
          claudeStream("msg_3", { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "toolu_3", name: "Bash", input: {} } }),
          claudeStream("msg_3", { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: "{\"command\":\"rm -rf build\"}" } }),
          claudeAssistant("msg_3", [{ type: "tool_use", id: "toolu_3", name: "Bash", input: { command: "rm -rf build" } }]),
          claudeStream("msg_3", { type: "content_block_stop", index: 0 }),
          claudeToolResult("toolu_3", "Denied by the user in Relay.", { decision: "reject", source: "user_temporary" }),
        ]
      : []),
    claudeStream("msg_4", { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } }),
    claudeStream("msg_4", { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "大体正确。" } }),
    claudeStream("msg_4", { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "分支与 origin/main 对齐。" } }),
    claudeAssistant("msg_4", [{ type: "text", text: "大体正确。分支与 origin/main 对齐。" }]),
    claudeStream("msg_4", { type: "content_block_stop", index: 1 }),
    claudeStream("msg_4", { type: "message_stop" }),
    { type: "result", subtype: "success", is_error: false, result: "大体正确。分支与 origin/main 对齐。", stop_reason: "end_turn", ...CLAUDE_SESSION },
  ]);
}

describe("runtime transcripts: claude", () => {
  for (const bridged of [false, true]) {
    it(`renders a ${bridged ? "claude-mcp bridged" : "plain"} run's tools, reply, and finish`, () => {
      const segments = assertRendersTranscript("claude", claudeRun({ bridged }));
      const expectedTools = ["Bash git status --short --branch && git log --oneline -12"];
      if (bridged) expectedTools.push("AskUserQuestion", "Bash rm -rf build");
      assert.deepEqual(tools(segments), expectedTools);
      assert.deepEqual(texts(segments), ["大体正确。分支与 origin/main 对齐。"]);
      assert.ok(hasTerminalOutcome(segments));
    });
  }
});

// ---------------------------------------------------------------- Codex

function codexRun({ bridged }: { bridged: boolean }): string {
  const configWarning = "Codex is ignoring 1 unrecognized configuration setting.";
  const read = "/bin/bash -lc 'cat threads/a2fa25a1/HANDOFF.md'";
  const write = "/bin/bash -lc \"cat > .relay/round-result.json <<'EOF'\n{}\nEOF\"";
  return jsonl([
    { type: "thread.started", thread_id: "01a144e1" },
    { type: "item.completed", item: { id: "item_0", type: "error", message: configWarning } },
    { type: "turn.started" },
    { type: "item.completed", item: { id: "item_2", type: "reasoning", text: "**Checking the handoff first**" } },
    { type: "item.completed", item: { id: "item_3", type: "agent_message", text: "我先看这条线程的交接记录。" } },
    { type: "item.started", item: { id: "item_4", type: "command_execution", command: read, aggregated_output: "", exit_code: null, status: "in_progress" } },
    { type: "item.completed", item: { id: "item_4", type: "command_execution", command: read, aggregated_output: "# Handoff\n", exit_code: 0, status: "completed" } },
    ...(bridged
      ? [
          // App-server items the adapter maps into exec's shape: a command the
          // person declined, an MCP tool call, and a file change.
          { type: "item.started", item: { id: "item_5", type: "command_execution", command: "/bin/bash -lc 'rm -rf build'", aggregated_output: "", exit_code: null, status: "in_progress" } },
          { type: "item.completed", item: { id: "item_5", type: "command_execution", command: "/bin/bash -lc 'rm -rf build'", aggregated_output: "", exit_code: null, status: "declined" } },
          { type: "item.started", item: { id: "item_6", type: "mcp_tool_call", server: "codegraph", tool: "search", arguments: { query: "parseCodex" }, result: null, error: null, status: "in_progress" } },
          { type: "item.completed", item: { id: "item_6", type: "mcp_tool_call", server: "codegraph", tool: "search", arguments: { query: "parseCodex" }, result: { content: [], structured_content: null }, error: null, status: "completed" } },
          { type: "item.completed", item: { id: "item_7", type: "file_change", changes: [{ path: "README.md", kind: "update" }], status: "completed" } },
        ]
      : []),
    { type: "item.started", item: { id: "item_8", type: "command_execution", command: write, aggregated_output: "", exit_code: null, status: "in_progress" } },
    { type: "item.completed", item: { id: "item_8", type: "command_execution", command: write, aggregated_output: "", exit_code: 0, status: "completed" } },
    { type: "item.completed", item: { id: "item_9", type: "agent_message", text: "最近的改动集中在 Web 体验和 E2E 测试。" } },
    { type: "turn.completed", usage: { input_tokens: 275582, cached_input_tokens: 237312, cache_write_input_tokens: 0, output_tokens: 1006, reasoning_output_tokens: 95 } },
  ]);
}

describe("runtime transcripts: codex", () => {
  for (const bridged of [false, true]) {
    it(`renders a ${bridged ? "codex-app-server bridged" : "plain"} run's commands, reasoning, reply, and finish`, () => {
      const segments = assertRendersTranscript("codex", codexRun({ bridged }));
      const expected = ["/bin/bash -lc 'cat threads/a2fa25a1/HANDOFF.md'"];
      if (bridged) expected.push("/bin/bash -lc 'rm -rf build'");
      expected.push("/bin/bash -lc \"cat > .relay/round-result.json <<'EOF'\n{}\nEOF\"");
      assert.deepEqual(commands(segments), expected);
      assert.deepEqual(tools(segments), bridged ? ["codegraph.search parseCodex"] : []);
      assert.deepEqual(texts(segments, "thinking"), ["**Checking the handoff first**"]);
      assert.deepEqual(texts(segments), ["我先看这条线程的交接记录。", "最近的改动集中在 Web 体验和 E2E 测试。"]);
      assert.ok(hasTerminalOutcome(segments));
    });
  }
});

// ---------------------------------------------------------------- Pi

// Pi's `--mode json` as the BoxLite guest's Pi prints it: every
// `message_update` carries the assistant event and usage but no `message`
// snapshot. The pi-extension adapter only hooks `tool_call`, so a bridged run
// prints the same frames (a blocked call still starts and ends as a tool).
const piUpdate = (assistantMessageEvent: Record<string, unknown>) =>
  ({ type: "message_update", usage: { input: 0, output: 0, totalTokens: 3304 }, assistantMessageEvent });

function piRun({ bridged }: { bridged: boolean }): string {
  const turn = (thinking: string, call: { id: string; name: string; args: Record<string, unknown>; blocked?: boolean }) => [
    { type: "turn_start" },
    { type: "message_start", message: { role: "assistant", content: [] } },
    piUpdate({ type: "thinking_start", contentIndex: 0 }),
    piUpdate({ type: "thinking_delta", contentIndex: 0, delta: thinking.slice(0, 12) }),
    piUpdate({ type: "thinking_delta", contentIndex: 0, delta: thinking.slice(12) }),
    piUpdate({ type: "thinking_end", contentIndex: 0, content: thinking }),
    piUpdate({ type: "toolcall_start", contentIndex: 1, id: call.id, toolName: call.name }),
    piUpdate({ type: "toolcall_delta", contentIndex: 1, delta: JSON.stringify(call.args) }),
    piUpdate({ type: "toolcall_end", contentIndex: 1, toolCall: { type: "toolCall", id: call.id, name: call.name, arguments: call.args } }),
    {
      type: "message_end",
      message: { role: "assistant", content: [{ type: "thinking", thinking }, { type: "toolCall", id: call.id, name: call.name, arguments: call.args }], stopReason: "toolUse" },
    },
    { type: "tool_execution_start", toolCallId: call.id, toolName: call.name, args: call.args },
    {
      type: "tool_execution_end",
      toolCallId: call.id,
      toolName: call.name,
      result: { content: [{ type: "text", text: call.blocked ? "Denied by the user in Relay." : "total 8\n" }] },
      isError: Boolean(call.blocked),
    },
    { type: "turn_end", message: { role: "assistant", content: [{ type: "thinking", thinking }], stopReason: "toolUse" }, toolResults: [] },
  ];
  const reply = "研究已完成，交付物已就绪。";
  return jsonl([
    { type: "session", version: 3, id: "01a0c4d1", cwd: "/workspace" },
    { type: "agent_start" },
    ...turn("The user is asking about agentic workflow trends.", { id: "call_1", name: "bash", args: { command: "ls -la /workspace" } }),
    ...(bridged
      ? turn("Clean the build directory before writing.", { id: "call_2", name: "bash", args: { command: "rm -rf build" }, blocked: true })
      : []),
    { type: "turn_start" },
    { type: "message_start", message: { role: "assistant", content: [] } },
    piUpdate({ type: "thinking_start", contentIndex: 0 }),
    piUpdate({ type: "thinking_delta", contentIndex: 0, delta: "Deliverable verified." }),
    piUpdate({ type: "thinking_end", contentIndex: 0, content: "Deliverable verified." }),
    piUpdate({ type: "text_start", contentIndex: 1 }),
    piUpdate({ type: "text_delta", contentIndex: 1, delta: reply.slice(0, 6) }),
    piUpdate({ type: "text_delta", contentIndex: 1, delta: reply.slice(6) }),
    piUpdate({ type: "text_end", contentIndex: 1, content: reply }),
    { type: "message_end", message: { role: "assistant", content: [{ type: "thinking", thinking: "Deliverable verified." }, { type: "text", text: reply }], stopReason: "stop" } },
    { type: "turn_end", message: { role: "assistant", content: [{ type: "text", text: reply }], stopReason: "stop" }, toolResults: [] },
    { type: "agent_end", messages: [] },
  ]);
}

describe("runtime transcripts: pi", () => {
  it("preserves standalone whitespace and completes each indexed content block", () => {
    const content = [
      { type: "text", text: "First\n\nsecond" },
      { type: "text", text: "Arrived in text_end." },
      { type: "text", text: "Arrived in message_end." },
    ];
    const message = { role: "assistant", content, stopReason: "stop" };
    const raw = jsonl([
      { type: "turn_start" },
      ...["First", "\n\n", "second"].map((delta) => piUpdate({ type: "text_delta", contentIndex: 0, delta })),
      piUpdate({ type: "text_end", contentIndex: 0, content: content[0]!.text }),
      piUpdate({ type: "text_end", contentIndex: 1, content: content[1]!.text }),
      { type: "message_end", message },
      { type: "turn_end", message },
    ]);
    assert.deepEqual(texts(assertRendersTranscript("pi", raw)), content.map((block) => block.text));
    assert.equal(
      stripVTControlCharacters(new PiStreamRenderer().feed(raw)),
      "● First\n\n  second\n● Arrived in text_end.\n● Arrived in message_end.\n",
    );
  });

  it("keeps the partial reply and shows a repeated assistant failure once", () => {
    const text = "The partial reply.";
    const message = {
      role: "assistant", content: [{ type: "text", text }],
      stopReason: "error", errorMessage: "Provider disconnected",
    };
    const raw = jsonl([
      { type: "turn_start" },
      piUpdate({ type: "text_delta", contentIndex: 0, delta: text }),
      { type: "message_end", message },
      { type: "turn_end", message },
    ]);

    const segments = assertRendersTranscript("pi", raw);
    assert.deepEqual(segments, [
      { kind: "text", text },
      { kind: "status", tone: "bad", text: "Pi error: Provider disconnected" },
    ]);
    assert.equal(hasTerminalOutcome(segments), true);
    const terminal = stripVTControlCharacters(new PiStreamRenderer().feed(raw));
    assert.match(terminal, /The partial reply\.[\s\S]*ERR\s+Pi error: Provider disconnected/);
    assert.equal(terminal.split("Provider disconnected").length - 1, 1);
  });

  it("reconciles the final retry error with the preceding assistant failure", () => {
    const errorMessage = "Rate limited";
    const raw = jsonl([
      { type: "turn_start" },
      { type: "turn_end", message: { role: "assistant", stopReason: "error", errorMessage } },
      { type: "auto_retry_end", success: false, finalError: errorMessage },
      { type: "agent_settled" },
    ]);
    assert.deepEqual(assertRendersTranscript("pi", raw), [
      { kind: "status", tone: "bad", text: "Pi error: Rate limited" },
    ]);
  });

  it("keeps an announced Pi retry active and displays an exhausted retry as terminal", () => {
    const errorMessage = "Rate limited";
    const failure = { type: "turn_end", message: { role: "assistant", stopReason: "error", errorMessage } };
    const attempt = jsonl([{ type: "turn_start" }, failure, { type: "agent_end", willRetry: true }]);
    const retry = jsonl([
      { type: "auto_retry_start", attempt: 1, maxAttempts: 2, errorMessage },
      { type: "turn_start" },
      { type: "tool_execution_start", toolCallId: "retry-call", toolName: "read", args: { path: "status.md" } },
    ]);
    assert.equal(hasTerminalOutcome(parseAgentStream("pi", attempt)), false);
    assert.equal(hasTerminalOutcome(assertRendersTranscript("pi", attempt + retry)), false);
    const olderRun = jsonl([{ type: "turn_start" }, failure]) + retry;
    assert.equal(hasTerminalOutcome(assertRendersTranscript("pi", olderRun)), false);
    assert.equal(hasTerminalOutcome(assertRendersTranscript("pi", attempt + retry + jsonl([
      failure, { type: "auto_retry_end", success: false, finalError: errorMessage },
    ]))), true);
  });

  it("reconciles an earlier recovered Pi block and a rewritten reply in final order", () => {
    const message = { role: "assistant", content: [
      { type: "text", text: "First block." },
      { type: "text", text: "Second block, revised." },
    ] };
    const raw = jsonl([
      { type: "turn_start" },
      piUpdate({ type: "text_delta", contentIndex: 1, delta: "Second block, draft." }),
      { type: "message_end", message },
      { type: "turn_end", message },
    ]);
    assert.deepEqual(texts(assertRendersTranscript("pi", raw)), ["First block.", "Second block, revised."]);
    const output = stripVTControlCharacters(new PiStreamRenderer().feed(raw));
    assert.match(output, /Pi final reply\n● First block\.\n● Second block, revised\.\n$/);
    assert.equal(output.split("Second block, revised.").length - 1, 1);
  });

  for (const bridged of [false, true]) {
    it(`renders a ${bridged ? "pi-extension bridged" : "plain"} run's thinking, tools, and reply`, () => {
      const segments = assertRendersTranscript("pi", piRun({ bridged }));
      const expectedTools = ["bash ls -la /workspace"];
      if (bridged) expectedTools.push("bash rm -rf build");
      assert.deepEqual(tools(segments), expectedTools);
      const expectedThinking = ["The user is asking about agentic workflow trends."];
      if (bridged) expectedThinking.push("Clean the build directory before writing.");
      expectedThinking.push("Deliverable verified.");
      assert.deepEqual(texts(segments, "thinking"), expectedThinking);
      assert.deepEqual(texts(segments), ["研究已完成，交付物已就绪。"]);
    });
  }

  it("streams Pi's reply while the turn is still open, before message_end restates it", () => {
    const raw = piRun({ bridged: false });
    const open = raw.slice(0, raw.indexOf("\"type\":\"text_end\""));
    const live = new AgentStreamAccumulator("pi").update(open.slice(0, open.lastIndexOf("\n") + 1));
    assert.deepEqual(texts(live), ["研究已完成，交付物已就绪。"]);
  });

  it("echoes thinking and each tool call once in the terminal", () => {
    const terminal = stripVTControlCharacters(new PiStreamRenderer().feed(piRun({ bridged: false })));
    assert.match(terminal, /○ The user is asking about agentic workflow trends\./);
    assert.match(terminal, /⏺.*bash/);
    assert.equal(terminal.split("⏺").length - 1, 1);
  });
});

it("renders both streamed and complete OpenCode reasoning in the terminal", () => {
  const terminal = stripVTControlCharacters(new OpenCodeStreamRenderer().feed(jsonl([
    { type: "reasoning", delta: true, part: { messageID: "thought", text: "Inspect " } },
    { type: "reasoning", delta: true, part: { messageID: "thought", text: "the input." } },
    { type: "text", delta: true, part: { messageID: "reply", text: "Checked." } },
    { type: "reasoning", part: { text: "Verify the output." } },
  ])));
  assert.match(terminal, /○ Inspect the input\.\n+● Checked\.\n+○ Verify the output\./);
});

it("preserves the indentation of complete OpenCode replies", () => {
  const text = "    const value = 42;\n    console.log(value);";
  const raw = jsonl([{ type: "text", part: { text: `${text}\n` } }]);
  assert.deepEqual(texts(assertRendersTranscript("opencode", raw)), [text]);
  const terminal = stripVTControlCharacters(new OpenCodeStreamRenderer().feed(raw));
  assert.match(terminal, /●     const value = 42;\n      console\.log\(value\);/);
});

describe("runtime transcripts: codex failures", () => {
  it("names the API error, not its JSON envelope, when a turn fails", () => {
    // Captured from a plain `codex exec --json` run on an unsupported model.
    const envelope = JSON.stringify({
      type: "error",
      status: 400,
      error: { type: "invalid_request_error", message: "The 'gpt-5.1-codex' model is not supported when using Codex with a ChatGPT account." },
    });
    const raw = jsonl([
      { type: "thread.started", thread_id: "01a121a5" },
      { type: "item.completed", item: { id: "item_2", type: "error", message: "Model metadata for `gpt-5.1-codex` not found." } },
      { type: "turn.started" },
      { type: "error", message: envelope },
      { type: "turn.failed", error: { message: envelope } },
    ]);
    const segments = assertRendersTranscript("codex", raw);
    const messages = segments.flatMap((segment) => segment.kind === "narration" && segment.params?.message !== undefined ? [String(segment.params.message)] : []);
    assert.deepEqual(messages, [
      "The 'gpt-5.1-codex' model is not supported when using Codex with a ChatGPT account.",
      "The 'gpt-5.1-codex' model is not supported when using Codex with a ChatGPT account.",
    ]);
    assert.ok(hasTerminalOutcome(segments));
  });

  it("keeps a plain-text error message as written", () => {
    const segments = parseAgentStream("codex", jsonl([{ type: "turn.failed", error: { message: "stream disconnected before completion" } }]));
    assert.deepEqual(segments, [{ kind: "narration", key: "agent_stream.codex_failed", params: { message: "stream disconnected before completion", tone: "bad" } }]);
  });
});

it("shows Codex text before completion and reconciles the final message by item", () => {
  const first = jsonl([
    { type: "turn.started" },
    { type: "item.delta", item: { id: "m_1", type: "agent_message", delta: "First" } },
  ]);
  const second = jsonl([{ type: "item.delta", item: { id: "m_1", type: "agent_message", delta: " draft" } }]);
  const complete = jsonl([{ type: "item.completed", item: { id: "m_1", type: "agent_message", text: "First reply." } }]);
  const accumulator = new AgentStreamAccumulator("codex");
  assert.deepEqual(texts(accumulator.update(first)), ["First"]);
  assert.deepEqual(texts(accumulator.update(first + second)), ["First draft"]);
  assert.deepEqual(texts(accumulator.update(first + second + complete)), ["First reply."]);
  assert.deepEqual(streamed("codex", first + second + complete, 7), parseAgentStream("codex", first + second + complete));

  const terminal = new CodexStreamRenderer();
  assert.match(stripVTControlCharacters(terminal.feed(first)), /● First$/);
  assert.equal(terminal.feed(second), " draft");
  assert.match(stripVTControlCharacters(terminal.feed(complete)), /First reply\./);
  const matching = new CodexStreamRenderer();
  matching.feed(first + second);
  assert.equal(matching.feed(jsonl([{ type: "item.completed", item: { id: "m_1", type: "agent_message", text: "First draft" } }])), "\n");
});
