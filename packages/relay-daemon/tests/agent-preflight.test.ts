import assert from "node:assert/strict";
import test from "node:test";

import {
  AgentNotInstalledError,
  AgentUnresponsiveError,
  agentPreflightError,
  agentPreflightTimeoutMs,
  runBoundedPreflight,
} from "../src/agent-preflight.js";

const hangUntilAborted = (signal: AbortSignal) => new Promise<{ exit_code: number }>((resolve) => {
  signal.addEventListener("abort", () => resolve({ exit_code: 143 }), { once: true });
});

test("a failed check preserves diagnostics from every output channel", () => {
  const error = agentPreflightError("claude", {
    exit_code: 1,
    stderr: "Warning: using custom config",
    stdout: "Not logged in",
    error_message: "Process exited with code 1",
  });
  assert.match(error.message, /Claude Code auth check failed \(exit code 1\)/);
  assert.match(error.message, /Warning: using custom config/);
  assert.match(error.message, /Not logged in/);
  assert.match(error.message, /Process exited with code 1/);
});

test("blank stderr does not hide the actual failure", () => {
  const error = agentPreflightError("codex", { exit_code: 1, stderr: " \n", stdout: "Not logged in" });
  assert.match(error.message, /Not logged in/);
});

test("a failed check without output still reports its exit code", () => {
  assert.match(agentPreflightError("codex", { exit_code: 2 }).message, /check failed \(exit code 2\)/);
});

test("repeated diagnostics are shown once", () => {
  const error = agentPreflightError("codex", { exit_code: 1, stdout: "Not logged in", stderr: "Not logged in" });
  assert.equal(error.message.split("Not logged in").length, 2);
});

test("a passing check resolves", async () => {
  await runBoundedPreflight("claude", undefined, async () => ({ exit_code: 0 }), 1_000);
});

test("a missing CLI reads as not installed", async () => {
  await assert.rejects(
    runBoundedPreflight("codex", undefined, async () => ({ exit_code: 127, stderr: "bash: codex: command not found" }), 1_000),
    (error) => error instanceof AgentNotInstalledError && /`codex` was not found on PATH/.test(error.message),
  );
});

test("an installed CLI whose check fails reads as a plain failure", async () => {
  await assert.rejects(
    runBoundedPreflight("claude", undefined, async () => ({ exit_code: 1, stderr: "Not logged in" }), 1_000),
    (error) => error instanceof Error
      && !(error instanceof AgentNotInstalledError)
      && !(error instanceof AgentUnresponsiveError)
      && /Not logged in/.test(error.message),
  );
});

test("a check that outlives its deadline reads as unresponsive", async () => {
  await assert.rejects(
    runBoundedPreflight("kimi", undefined, hangUntilAborted, 20),
    (error) => error instanceof AgentUnresponsiveError && /Kimi is not responding/.test(error.message),
  );
});

test("a thrown error after the deadline still reads as unresponsive", async () => {
  await assert.rejects(
    runBoundedPreflight("kimi", undefined, (signal) => new Promise((_, reject) => {
      signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    }), 20),
    AgentUnresponsiveError,
  );
});

test("cancellation by the caller is not mistaken for a hung runtime", async () => {
  const caller = new AbortController();
  const pending = runBoundedPreflight("claude", caller.signal, hangUntilAborted, 10_000);
  caller.abort();
  await assert.rejects(pending, (error) => !(error instanceof AgentUnresponsiveError));
});

test("the deadline is configurable and falls back on a bad value", (t) => {
  const prior = process.env.RELAY_DAEMON_AGENT_PREFLIGHT_TIMEOUT_MS;
  t.after(() => {
    if (prior === undefined) delete process.env.RELAY_DAEMON_AGENT_PREFLIGHT_TIMEOUT_MS;
    else process.env.RELAY_DAEMON_AGENT_PREFLIGHT_TIMEOUT_MS = prior;
  });
  process.env.RELAY_DAEMON_AGENT_PREFLIGHT_TIMEOUT_MS = "5000";
  assert.equal(agentPreflightTimeoutMs(), 5000);
  process.env.RELAY_DAEMON_AGENT_PREFLIGHT_TIMEOUT_MS = "soon";
  assert.equal(agentPreflightTimeoutMs(), 60_000);
});
