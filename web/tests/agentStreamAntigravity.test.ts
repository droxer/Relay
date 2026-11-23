import assert from "node:assert/strict";
import { test } from "node:test";
import { AgentStreamAccumulator } from "../src/lib/agent-stream/accumulator.ts";
import { parseAgentStream } from "../src/lib/agent-stream/parse.ts";

const frame = (event: Record<string, unknown>) => JSON.stringify(event) + "\n";

test("Antigravity joins ACP text fragments and keeps one tool row through completion", () => {
  const tool = { callID: "read-1", tool: "read_file" };
  const started = frame({ type: "tool_use", part: { ...tool, state: { status: "running", title: "/workspace/readme.md" } } });
  const finished = frame({ type: "tool_use", part: { ...tool, state: { status: "completed" } } });
  const first = frame({ type: "text", delta: true, part: { text: "Relay " } });
  const second = frame({ type: "text", delta: true, part: { text: "works." } });
  const raw = started + finished + first + second;
  const stream = new AgentStreamAccumulator("antigravity");

  assert.deepEqual(stream.update(started + finished + first + second.slice(0, 20)), [
    { kind: "tool", id: "read-1", name: "read_file", target: "/workspace/readme.md" },
    { kind: "text", text: "Relay " },
  ]);
  const expected = [
    { kind: "tool", id: "read-1", name: "read_file", target: "/workspace/readme.md" },
    { kind: "text", text: "Relay works." },
  ];
  assert.deepEqual(stream.update(raw), expected);
  assert.deepEqual(parseAgentStream("antigravity", raw), expected);
});

test("Antigravity labels ACP errors with the runtime name", () => {
  assert.deepEqual(parseAgentStream("antigravity", frame({ type: "error", error: { message: "Sign-in expired" } })), [
    { kind: "status", tone: "bad", text: "Google Antigravity error: Sign-in expired" },
  ]);
});
