import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { formatCompactTokens, freshTokens, mergeTokenUsage, sessionTokenUsage, splitCache } from "../src/lib/tokenUsage.js";
import type { RelaySession } from "../src/types.js";

describe("web token usage helpers", () => {
  it("merges reported token usage without estimating missing sessions", () => {
    const sessions = [
      { tokenUsage: { input: 10, output: 4, cache: 1, total: 15 } },
      {},
      { tokenUsage: { input: 2, output: 3, cache: 0, total: 5 } },
    ] as RelaySession[];

    assert.deepEqual(sessionTokenUsage(sessions), { input: 12, output: 7, cache: 1, cacheRead: 1, cacheWrite: 0, total: 20 });
    assert.equal(mergeTokenUsage([undefined]), undefined);
  });

  it("headlines fresh tokens, keeping cache reads out of the turn total", () => {
    const usage = { input: 10, output: 5, cache: 1_020, cacheRead: 1_000, cacheWrite: 20, total: 1_035 };
    assert.equal(freshTokens(usage), 35);
    assert.deepEqual(splitCache(usage), { cacheRead: 1_000, cacheWrite: 20 });
    // A record from before the split counts its combined cache as reads.
    assert.equal(freshTokens({ input: 10, output: 5, cache: 100, total: 115 }), 15);
  });

  it("formats compact token counts for thread rows", () => {
    assert.equal(formatCompactTokens(999), "999");
    assert.equal(formatCompactTokens(1_250), "1.3K");
    assert.equal(formatCompactTokens(1_250_000), "1.3M");
  });
});
