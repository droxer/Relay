import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { canonicalBrowserUrl } from "../src/lib/appRoute.js";
import {
  parseUrlFilters,
  writeUrlFilters,
  type FilterSpec,
} from "../src/lib/urlFilters.js";

interface DemoFilters {
  query: string;
  status: string;
}

const DEMO_DEFAULTS: DemoFilters = { query: "", status: "all" };
const DEMO_SPEC: FilterSpec<DemoFilters> = {
  query: { param: "q" },
  status: { param: "status", allowed: ["backlog", "done"] },
};

function applyFilters(search: string, next: DemoFilters): string {
  const url = new URL(`http://relay.local/backlog${search}`);
  writeUrlFilters(url, next, DEMO_DEFAULTS, DEMO_SPEC);
  return url.search;
}

describe("url filters", () => {
  it("parses owned params and falls back to defaults for the rest", () => {
    assert.deepEqual(parseUrlFilters("?q=foo&status=done", DEMO_DEFAULTS, DEMO_SPEC), {
      query: "foo",
      status: "done",
    });
    assert.deepEqual(parseUrlFilters("?sort=title", DEMO_DEFAULTS, DEMO_SPEC), DEMO_DEFAULTS);
    assert.deepEqual(parseUrlFilters(null, DEMO_DEFAULTS, DEMO_SPEC), DEMO_DEFAULTS);
  });

  it("reads enum values outside the allowed list as the default", () => {
    assert.deepEqual(parseUrlFilters("?status=bogus", DEMO_DEFAULTS, DEMO_SPEC), DEMO_DEFAULTS);
  });

  it("writes only non-default fields and clears fields back at the default", () => {
    assert.equal(applyFilters("", { query: "foo", status: "all" }), "?q=foo");
    assert.equal(applyFilters("?q=foo&status=done", { query: "foo", status: "all" }), "?q=foo");
    assert.equal(applyFilters("", DEMO_DEFAULTS), "");
  });

  it("leaves params owned by other controls alone", () => {
    assert.equal(applyFilters("?sort=title", { query: "x", status: "done" }), "?sort=title&q=x&status=done");
  });
});

describe("canonical filter params", () => {
  it("keeps the backlog's own filter params", () => {
    assert.equal(
      canonicalBrowserUrl("/backlog", "?status=blocked&q=foo&assignee=fei&source=routine"),
      "/backlog?q=foo&status=blocked&assignee=fei&source=routine",
    );
  });

  it("keeps the routines' own filter params", () => {
    assert.equal(
      canonicalBrowserUrl("/routines", "?type=job&state=overdue&cadence=daily"),
      "/automations?type=job&cadence=daily&state=overdue",
    );
  });

  it("drops enum values the filter cannot take", () => {
    assert.equal(canonicalBrowserUrl("/backlog", "?status=bogus&due=overdue"), "/backlog?due=overdue");
    assert.equal(canonicalBrowserUrl("/routines", "?state=enabled"), "/automations");
  });

  it("drops filter params on paths that do not own them", () => {
    assert.equal(canonicalBrowserUrl("/threads", "?status=blocked&q=foo"), "/threads");
    assert.equal(canonicalBrowserUrl("/computer", "?state=overdue"), "/computer");
  });
});
