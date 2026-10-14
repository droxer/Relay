import assert from "node:assert/strict";
import test from "node:test";
import { evaluateRoundResult, parseRoundResult } from "../src/round-result.js";

test("work evidence reaches the backend only for the current run", () => {
  const work = { status: "done", evidence: ["12 tests passed"], messages: [{ kind: "handoff", text: "API ready" }] };
  const raw = JSON.stringify({ status: "done", runId: "run-1", work });
  assert.deepEqual(parseRoundResult(raw, "run-1"), { status: "done", work });
  assert.equal(parseRoundResult(raw, "run-2"), undefined);
});

test("a blocked round passes its offered answers through", () => {
  const raw = JSON.stringify({ status: "blocked", note: "Which env?", options: ["Staging", 3, "Prod"], runId: "run-1" });
  assert.deepEqual(parseRoundResult(raw, "run-1"), { status: "blocked", note: "Which env?", options: ["Staging", "Prod"] });
  const done = JSON.stringify({ status: "done", options: ["a", "b"], runId: "run-1" });
  assert.deepEqual(parseRoundResult(done, "run-1"), { status: "done" });
});

test("a project run's context suggestions pass through, bounded", () => {
  const raw = JSON.stringify({
    status: "done",
    runId: "run-1",
    contextSuggestions: [
      { text: " Use pnpm, not npm. ", evidence: "package.json has a pnpm lock" },
      { text: 42 },
      { text: "Second" }, { text: "Third" }, { text: "Fourth" },
    ],
  });
  assert.deepEqual(parseRoundResult(raw, "run-1"), {
    status: "done",
    contextSuggestions: [
      { text: "Use pnpm, not npm.", evidence: "package.json has a pnpm lock" },
      { text: "Second" },
      { text: "Third" },
    ],
  });
});

test("a rejected verdict names why, never silently vanishes", () => {
  const blocked = { status: "blocked", note: "Which env?", runId: "run-1" };
  const cases: Array<[string, string]> = [
    ["not json at all", "malformed"],
    ['["done"]', "not_object"],
    ["null", "not_object"],
    ['"done"', "not_object"],
    [JSON.stringify({ ...blocked, status: "whatever" }), "invalid_status"],
    [JSON.stringify({ note: "no status", runId: "run-1" }), "invalid_status"],
    [JSON.stringify({ ...blocked, runId: "run-2" }), "run_id_mismatch"],
    [JSON.stringify({ status: "blocked", note: "Which env?" }), "run_id_mismatch"],
  ];
  for (const [raw, reason] of cases) {
    assert.deepEqual(evaluateRoundResult(raw, "run-1"), { kind: "rejected", reason }, raw);
    assert.equal(parseRoundResult(raw, "run-1"), undefined, raw);
  }
  assert.deepEqual(evaluateRoundResult(JSON.stringify(blocked), "run-1"), {
    kind: "accepted",
    result: { status: "blocked", note: "Which env?" },
  });
});
