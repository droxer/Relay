import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  activityChartMetrics,
  activityOutcomes,
  activityTotals,
  axisTicks,
  niceScaleMax,
  successRate,
} from "../src/lib/activityChart.js";

const day = (date: string, count: number, completed: number, failed: number) => ({ date, count, completed, failed });

describe("activity chart outcomes", () => {
  it("splits each day into completed, failed, and everything else", () => {
    assert.deepEqual(activityOutcomes([day("2026-10-28", 10, 6, 1)]), [
      { date: "2026-10-28", completed: 6, failed: 1, other: 3, total: 10 },
    ]);
  });

  it("never stacks a bar taller than the day's count", () => {
    const [outcome] = activityOutcomes([day("2026-10-28", 5, 4, 3)]);
    assert.deepEqual(outcome, { date: "2026-10-28", completed: 4, failed: 1, other: 0, total: 5 });
  });

  it("treats negative counts as zero", () => {
    const [outcome] = activityOutcomes([day("2026-10-28", -2, -1, 4)]);
    assert.deepEqual(outcome, { date: "2026-10-28", completed: 0, failed: 0, other: 0, total: 0 });
  });

  it("sums the window", () => {
    assert.deepEqual(activityTotals([day("a", 10, 6, 1), day("b", 4, 2, 2)]), {
      completed: 8, failed: 3, other: 3, total: 14,
    });
  });
});

describe("success rate", () => {
  it("is the completed share of finished threads, ignoring open ones", () => {
    assert.equal(successRate([day("a", 20, 9, 1)]), 0.9);
  });

  it("is null when nothing finished, never 0%", () => {
    assert.equal(successRate([]), null);
    assert.equal(successRate([day("a", 3, 0, 0)]), null);
  });
});

describe("chart scale", () => {
  it("puts four gridlines on round whole numbers", () => {
    assert.equal(niceScaleMax(131), 200);
    assert.equal(niceScaleMax(100), 100);
    assert.equal(niceScaleMax(7), 8);
    assert.equal(niceScaleMax(90), 100);
    assert.equal(niceScaleMax(8_400_000), 10_000_000);
  });

  it("never steps a count axis by a fraction", () => {
    for (const peak of [0, 1, 3, 5, 6, 9, 11, 17, 33, 99]) {
      for (const tick of axisTicks(niceScaleMax(peak))) {
        assert.ok(Number.isInteger(tick), `peak ${peak} produced gridline ${tick}`);
      }
    }
  });

  it("honours the floor and survives an empty window", () => {
    assert.equal(niceScaleMax(0, 4), 4);
    assert.equal(niceScaleMax(0, 0), 4);
    assert.deepEqual(activityChartMetrics([]), { dataPeak: 0, scaleMax: 4 });
  });

  it("reports the observed peak, not the scale", () => {
    assert.deepEqual(activityChartMetrics([day("a", 3, 1, 0)]), { dataPeak: 3, scaleMax: 4 });
  });

  it("places gridlines from the baseline up", () => {
    assert.deepEqual(axisTicks(200), [0, 50, 100, 150, 200]);
  });
});
