import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { formatChartDate } from "../src/lib/chartDate.ts";

describe("chart calendar dates", () => {
  it("keeps date-only buckets on their calendar day in western and eastern timezones", () => {
    const previous = process.env.TZ;
    try {
      for (const zone of ["America/Los_Angeles", "Pacific/Honolulu", "Asia/Shanghai", "UTC"]) {
        process.env.TZ = zone;
        assert.equal(formatChartDate("2026-09-07", "en-US"), "Sep 7", zone);
        assert.equal(formatChartDate("2026-01-01", "en-US"), "Jan 1", zone);
      }
    } finally {
      if (previous === undefined) delete process.env.TZ;
      else process.env.TZ = previous;
    }
  });

  it("retains local-time formatting for timestamps and preserves invalid input", () => {
    const previous = process.env.TZ;
    try {
      process.env.TZ = "America/Los_Angeles";
      assert.equal(formatChartDate("2026-09-07T00:00:00Z", "en-US"), "Sep 6");
      assert.equal(formatChartDate("unknown", "en-US"), "unknown");
    } finally {
      if (previous === undefined) delete process.env.TZ;
      else process.env.TZ = previous;
    }
  });
});
