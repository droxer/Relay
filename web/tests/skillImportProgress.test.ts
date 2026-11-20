import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  formatImportElapsed,
  SKILL_IMPORT_LONG_MS,
  SKILL_IMPORT_SLOW_MS,
  skillImportStage,
} from "../src/lib/skillImportProgress.js";

describe("skillImportStage", () => {
  it("starts plain, then says a large import is slow, then asks to wait", () => {
    assert.equal(skillImportStage(0), "started");
    assert.equal(skillImportStage(SKILL_IMPORT_SLOW_MS - 1), "started");
    assert.equal(skillImportStage(SKILL_IMPORT_SLOW_MS), "slow");
    assert.equal(skillImportStage(SKILL_IMPORT_LONG_MS - 1), "slow");
    assert.equal(skillImportStage(SKILL_IMPORT_LONG_MS), "long");
  });
});

describe("formatImportElapsed", () => {
  it("reads as m:ss and keeps counting minutes", () => {
    assert.equal(formatImportElapsed(0), "0:00");
    assert.equal(formatImportElapsed(7_900), "0:07");
    assert.equal(formatImportElapsed(125_000), "2:05");
    assert.equal(formatImportElapsed(3_725_000), "62:05");
  });

  it("never shows a negative clock", () => {
    assert.equal(formatImportElapsed(-500), "0:00");
  });
});
