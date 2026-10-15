import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, it } from "node:test";

import { resolveUrlSearchValue } from "../src/lib/urlSearchState.js";

describe("URL search state history", () => {
  it("resolves functional updates exactly once", () => {
    let calls = 0;
    const next = resolveUrlSearchValue("activities", (current) => {
      calls += 1;
      return current === "activities" ? "artifacts" : "activities";
    });

    assert.equal(next, "artifacts");
    assert.equal(calls, 1);
  });

  it("derives the value from the URL store and subscribes to back/forward", async () => {
    const source = await readFile(resolve("web/src/hooks/useUrlSearchState.ts"), "utf8");
    const store = await readFile(resolve("web/src/hooks/useLocationSearch.ts"), "utf8");

    // No copy of the URL in React state: a changed fallback must apply at once.
    assert.doesNotMatch(source, /useState/);
    assert.match(source, /useLocationSearch\(\)/);
    assert.match(store, /useSyncExternalStore/);
    assert.match(store, /window\.addEventListener\("popstate", onChange\)/);
    assert.match(store, /window\.addEventListener\(APP_NAVIGATION_EVENT, onChange\)/);
    assert.match(source, /window\.history\[historyMode === "push"/);
    assert.match(source, /window\.dispatchEvent\(new Event\(APP_NAVIGATION_EVENT\)\)/);
  });
});
