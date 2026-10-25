import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { NEXT_STEPS_RELATIVE_PATH } from "relay-core";
import { consumeNextSteps } from "../src/next-steps.js";

function workspaceWith(contents?: string): string {
  const workspace = mkdtempSync(join(tmpdir(), "relay-next-steps-"));
  if (contents !== undefined) {
    mkdirSync(join(workspace, ".relay"), { recursive: true });
    writeFileSync(join(workspace, NEXT_STEPS_RELATIVE_PATH), contents);
  }
  return workspace;
}

it("reads a run's suggested next steps once, bounded, and removes the file", () => {
  const workspace = workspaceWith(JSON.stringify({ nextSteps: [" Add  tests ", "Add tests", 3, "Ship it", "Docs", "Extra"] }));
  assert.deepEqual(consumeNextSteps(workspace), ["Add tests", "Ship it", "Docs"]);
  assert.equal(existsSync(join(workspace, NEXT_STEPS_RELATIVE_PATH)), false);
  assert.deepEqual(consumeNextSteps(workspace), []);
});

it("treats a missing, malformed, or oversized file as no suggestion", () => {
  assert.deepEqual(consumeNextSteps(workspaceWith()), []);
  const malformed = workspaceWith("{not json");
  assert.deepEqual(consumeNextSteps(malformed), []);
  assert.equal(existsSync(join(malformed, NEXT_STEPS_RELATIVE_PATH)), false);
  assert.deepEqual(consumeNextSteps(workspaceWith(JSON.stringify(["Ship it"]))), []);
  assert.deepEqual(consumeNextSteps(workspaceWith(JSON.stringify({ nextSteps: ["x".repeat(9000)] }))), []);
});
