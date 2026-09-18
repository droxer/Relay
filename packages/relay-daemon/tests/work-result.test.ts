import assert from "node:assert/strict";
import test from "node:test";
import { parseRoundResult } from "../src/round-result.js";

test("work evidence reaches the backend only for the current run", () => {
  const work = { status: "done", evidence: ["12 tests passed"], messages: [{ kind: "handoff", text: "API ready" }] };
  const raw = JSON.stringify({ status: "done", runId: "run-1", work });
  assert.deepEqual(parseRoundResult(raw, "run-1"), { status: "done", work });
  assert.equal(parseRoundResult(raw, "run-2"), undefined);
});
