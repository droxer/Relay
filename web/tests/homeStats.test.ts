import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  chartLabelIndices,
  formatStatsWindow,
  niceTokenScale,
  sumDailyFresh,
  summarizeTopRuntimes,
} from "../src/lib/homeStats.ts";

describe("summarizeTopRuntimes", () => {
  it("formats top runtimes using product casing and sums remaining runs", () => {
    const result = summarizeTopRuntimes([
      { agent: "claude", runs: 12, reportedRuns: 12, fresh: 1000, cacheRead: 0 },
      { agent: "opencode", runs: 5, reportedRuns: 5, fresh: 500, cacheRead: 0 },
      { agent: "codex", runs: 3, reportedRuns: 3, fresh: 300, cacheRead: 0 },
      { agent: "antigravity", runs: 2, reportedRuns: 2, fresh: 200, cacheRead: 0 },
      { agent: null, runs: 4, reportedRuns: 0, fresh: 0, cacheRead: 0 },
    ], "en", 2);

    assert.deepEqual(result.items, [
      { agent: "claude", label: "Claude", runs: 12, formatted: "12" },
      { agent: "opencode", label: "OpenCode", runs: 5, formatted: "5" },
    ]);
    assert.equal(result.remainingRuns, 5);
  });

  it("returns empty items when no named runtime has runs", () => {
    assert.deepEqual(summarizeTopRuntimes([], "en"), { items: [], remainingRuns: 0 });
  });
});

describe("niceTokenScale", () => {
  it("returns clean integer ticks strictly above the peak", () => {
    const scale = niceTokenScale([12_000, 38_000, 62_000, 44_000]);
    assert.ok(scale.max > 62_000);
    assert.equal(scale.ticks[0], 0);
    assert.equal(scale.ticks.at(-1), scale.max);
    assert.equal(scale.ticks.length, 5);
    assert.ok(scale.ticks.every((tick) => Number.isInteger(tick)));
  });

  it("uses a clean zero-baseline scale when all values are zero", () => {
    assert.deepEqual(niceTokenScale([0, 0, 0]), { max: 4, ticks: [0, 1, 2, 3, 4] });
    assert.deepEqual(niceTokenScale([]), { max: 4, ticks: [0, 1, 2, 3, 4] });
  });
});

describe("chartLabelIndices", () => {
  it("labels every bucket when count fits within maxLabels", () => {
    assert.deepEqual(chartLabelIndices(5, 6), [0, 1, 2, 3, 4]);
  });

  it("uses one even step when count exceeds maxLabels", () => {
    const indices = chartLabelIndices(30, 6);
    assert.equal(indices[0], 0);
    assert.ok(indices.length <= 6);
    const step = indices[1] - indices[0];
    for (let i = 1; i < indices.length; i += 1) {
      assert.equal(indices[i] - indices[i - 1], step);
    }
  });
});

describe("formatStatsWindow & sumDailyFresh", () => {
  it("formats single-day and multi-day windows", () => {
    assert.equal(formatStatsWindow(null, null, "en"), null);
    assert.ok(formatStatsWindow("2026-11-23", "2026-11-27", "en")?.includes("–"));
    assert.ok(!formatStatsWindow("2026-11-27", "2026-11-27", "en")?.includes("–"));
  });

  it("sums daily fresh tokens accurately", () => {
    const total = sumDailyFresh([
      { date: "2026-11-23", input: 100, output: 50, cacheWrite: 10, cacheRead: 200, cache: 210, fresh: 160, total: 360 },
      { date: "2026-11-24", input: 200, output: 100, cacheWrite: 0, cacheRead: 0, cache: 0, fresh: 300, total: 300 },
    ]);
    assert.equal(total, 460);
  });
});
