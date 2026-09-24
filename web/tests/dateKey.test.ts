import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { dateFromKey } from "../src/lib/dateKey.js";
import { isoToday } from "../src/lib/routine.js";

/* Due and next-run dates are calendar days ("2026-07-19"), not instants. */
describe("dateFromKey", () => {
  it("reads a day key as that local calendar day, never shifted by the UTC offset", () => {
    const date = dateFromKey("2026-07-19")!;
    assert.equal(date.getFullYear(), 2026);
    assert.equal(date.getMonth(), 6);
    assert.equal(date.getDate(), 19);
    assert.equal(date.getHours(), 0);
  });

  it("round-trips with isoToday", () => {
    assert.equal(isoToday(dateFromKey("2026-02-28")!), "2026-02-28");
  });

  it("reads an empty or malformed key as no date", () => {
    assert.equal(dateFromKey(""), undefined);
    assert.equal(dateFromKey("2026-7-19"), undefined);
    assert.equal(dateFromKey("2026-02-31"), undefined);
  });
});
