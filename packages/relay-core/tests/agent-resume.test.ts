import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildClaudeCommand, buildCodexCommand, buildPiCommand, extractRuntimeSessionId, initialAgentState, runAgentNode,
} from "../src/index.js";
import type { StreamExecResult } from "../src/index.js";

const SESSION = "0b1c2d3e-4f50-4a6b-8c7d-9e0f1a2b3c4d";
const resuming = { ...initialAgentState("finish the report"), resume_session_id: SESSION };

test("a resumed run asks the CLI for its own session back", () => {
  assert.match(buildClaudeCommand(resuming), new RegExp(`'--resume' '${SESSION}'|--resume ${SESSION}`));
  const codex = buildCodexCommand(resuming);
  assert.match(codex, new RegExp(`exec'? '?resume .*${SESSION}`));
  assert.match(codex, /--json/);
  // The prompt tells the agent to continue, not start over.
  assert.match(buildClaudeCommand(resuming), /interrupted/);
});

test("a fresh run and a runtime without resume support never resume", () => {
  const fresh = initialAgentState("task");
  assert.doesNotMatch(buildClaudeCommand(fresh), /--resume/);
  assert.doesNotMatch(buildCodexCommand(fresh), /exec'? '?resume/);
  assert.doesNotMatch(buildPiCommand(resuming), new RegExp(SESSION));
});

test("each CLI's session id is read from its own stream", () => {
  assert.equal(extractRuntimeSessionId(
    `{"type":"system","subtype":"init","session_id":"${SESSION}"}\n{"type":"assistant"}\n`, "claude"), SESSION);
  assert.equal(extractRuntimeSessionId(
    `{"type":"thread.started","thread_id":"${SESSION}"}\n{"type":"turn.started"}\n`, "codex"), SESSION);
  assert.equal(extractRuntimeSessionId("plain text", "claude"), undefined);
  // Anything that is not a plain id is refused rather than replayed into argv.
  assert.equal(extractRuntimeSessionId(`{"type":"thread.started","thread_id":"x; rm -rf /"}`, "codex"), undefined);
  assert.equal(extractRuntimeSessionId(`{"type":"system","subtype":"init","session_id":"${SESSION}"}`, "pi"), undefined);
});

test("a run reports the session it ran in, and a dead resume falls back to a fresh run", async () => {
  const calls: string[] = [];
  const execStream = async (_cmd: string, args: string[] = []): Promise<StreamExecResult> => {
    const command = args.join(" ");
    calls.push(command);
    if (command.includes("--resume")) return { exit_code: 1, stdout: "", stderr: "No conversation found" };
    return { exit_code: 0, stdout: `{"type":"system","subtype":"init","session_id":"${SESSION.replace("0b", "ff")}"}\n`, stderr: "" };
  };
  const patch = await runAgentNode("claude", resuming, { execStream });
  assert.equal(calls.length, 2);
  assert.doesNotMatch(calls[1]!, /--resume/);
  assert.equal(patch.last_exit_code, 0);
  assert.equal(patch.runtime_session_id, SESSION.replace("0b", "ff"));
});
