import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { taskRef } from "../src/lib/taskRef.js";

describe("taskRef", () => {
  it("prints the full stored issue id", () => {
    assert.equal(taskRef("task_mfoo12_ab12cd"), "task_mfoo12_ab12cd");
  });

  it("is stable for one id and different for two", () => {
    assert.equal(taskRef("task_mfoo12_ab12cd"), taskRef("task_mfoo12_ab12cd"));
    assert.notEqual(taskRef("task_mfoo12_ab12cd"), taskRef("task_mfoo12_zz99yy"));
  });

  it("preserves legacy ids exactly", () => {
    assert.equal(taskRef("legacy-task-000042"), "legacy-task-000042");
    assert.equal(taskRef("abc"), "abc");
  });
});
