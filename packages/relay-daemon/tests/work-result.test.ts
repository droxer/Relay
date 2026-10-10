import assert from "node:assert/strict";
import test from "node:test";
import { parseRoundResult } from "../src/round-result.js";

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
