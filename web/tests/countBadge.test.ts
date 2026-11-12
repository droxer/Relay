import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { COUNT_BADGE_CAP, countBadgeText } from "../src/lib/countBadge.js";

describe("countBadgeText", () => {
  it("shows nothing for an empty or invalid count", () => {
    assert.equal(countBadgeText(0), "");
    assert.equal(countBadgeText(-1), "");
    assert.equal(countBadgeText(Number.NaN), "");
    assert.equal(countBadgeText(Number.POSITIVE_INFINITY), "");
  });

  it("shows the count up to the cap, then caps it", () => {
    assert.equal(countBadgeText(1), "1");
    assert.equal(countBadgeText(2.7), "2");
    assert.equal(countBadgeText(COUNT_BADGE_CAP), String(COUNT_BADGE_CAP));
    assert.equal(countBadgeText(COUNT_BADGE_CAP + 1), `${COUNT_BADGE_CAP}+`);
    assert.equal(countBadgeText(250), "9+");
  });
});
