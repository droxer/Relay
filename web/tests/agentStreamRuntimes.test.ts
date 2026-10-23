import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  AgentStreamAccumulator,
  displayAgentStreamSegments,
  hasTerminalOutcome,
  parseAgentStream,
  type AgentSegment,
} from "../src/lib/agentStream.js";
import type { AgentName } from "../src/types.js";

// Every runtime in both of its launch modes: the plain headless CLI, and the
// permission-bridged launch (claude-mcp, codex-app-server, kimi-acp,
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

// ---------------------------------------------------------------- Kimi

// `kimi -p --output-format stream-json` prints one assistant message per
// flush (text plus the calls it made), each call's result as a `tool` line,
// and meta lines; the kimi-acp adapter's StreamJsonWriter re-emits exactly
// that from ACP `session/update`s, naming each call by its first ACP title.
function kimiRun({ bridged }: { bridged: boolean }): string {
  const searchArgs = JSON.stringify({ query: "Open Maic 介绍" });
  const writeArgs = JSON.stringify({ content: "{\"status\":\"done\"}\n", path: ".relay/round-result.json" });
  return jsonl([
    { role: "meta", type: "system.version", version: "2.0.2" },
    {
      role: "assistant",
      content: "I'll look this up to make sure I give you accurate information.",
      tool_calls: [{ type: "function", id: "tool_Q", function: { name: "WebSearch", arguments: searchArgs } }],
    },
    { role: "tool", tool_call_id: "tool_Q", content: "Title: OpenMAIC/README-zh.md\nURL: https://github.com/THU-MAIC/OpenMAIC" },
    ...(bridged
      ? [
          // A shell call the person approved through the broker; the adapter
          // prints it with its result only once the call completes.
          { role: "assistant", tool_calls: [{ type: "function", id: "tool_S", function: { name: "Shell", arguments: JSON.stringify({ command: "ls -la" }) } }] },
          { role: "tool", tool_call_id: "tool_S", content: "total 0\n" },
        ]
      : []),
    { role: "assistant", content: "**OpenMAIC** 是清华大学开源的多智能体互动课堂平台。", tool_calls: [{ type: "function", id: "tool_W", function: { name: "Write", arguments: writeArgs } }] },
    { role: "tool", tool_call_id: "tool_W", content: "Wrote 18 bytes" },
    { role: "assistant", content: "以上即对 OpenMAIC 的介绍。" },
    { role: "meta", type: "session.resume_hint", session_id: "session_1", command: "kimi -r session_1" },
  ]);
}

describe("runtime transcripts: kimi", () => {
  for (const bridged of [false, true]) {
    it(`renders a ${bridged ? "kimi-acp bridged" : "plain"} run's tool calls and replies`, () => {
      const segments = assertRendersTranscript("kimi", kimiRun({ bridged }));
      const expectedTools = ["WebSearch Open Maic 介绍"];
      if (bridged) expectedTools.push("Shell ls -la");
      expectedTools.push("Write .relay/round-result.json");
      assert.deepEqual(tools(segments), expectedTools);
      assert.deepEqual(texts(segments), [
        "I'll look this up to make sure I give you accurate information.",
        "**OpenMAIC** 是清华大学开源的多智能体互动课堂平台。",
        "以上即对 OpenMAIC 的介绍。",
      ]);
    });
  }

  it("shows nothing but stays parseable when a run fails before its first message", () => {
    // Today's bridged capture: the version line, then the auth failure on stderr.
    const raw = jsonl([{ role: "meta", type: "system.version", version: "2.0.2" }]);
    assert.deepEqual(parseAgentStream("kimi", raw), []);
  });
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
