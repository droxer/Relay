import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { COMPACT_THRESHOLD, formatCompact } from "../src/lib/compactNumber.js";

describe("dashboard compact number voice", () => {
  it("keeps full precision below the threshold", () => {
    assert.equal(formatCompact(1_041, "en"), "1,041");
    assert.equal(formatCompact(COMPACT_THRESHOLD - 1, "en"), "99,999");
  });

  it("goes compact at and above the threshold", () => {
    assert.equal(formatCompact(943_500, "en"), "943.5K");
    assert.equal(formatCompact(16_280_000, "en"), "16.3M");
  });
});
