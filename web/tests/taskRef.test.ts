import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { taskRef } from "../src/lib/taskRef.js";

describe("taskRef", () => {
  it("prints an issue's sequence number, not its id", () => {
    assert.equal(taskRef({ id: "6f1c0d2e-uuid", number: 12 }), "#12");
  });

  it("prefixes an automation's number with the automations abbreviation", () => {
    assert.equal(taskRef({ id: "6f1c0d2e-uuid", number: 3, isRoutine: true }), "AUTO-3");
    assert.equal(taskRef({ id: "6f1c0d2e-uuid", number: 3, isRoutine: false }), "#3");
  });

  it("falls back to the stored id until the backend numbers the task", () => {
    assert.equal(taskRef({ id: "legacy-task-000042" }), "legacy-task-000042");
  });
});
