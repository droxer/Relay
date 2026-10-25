import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import {
  BUILD_CHECK_THROTTLE_MS,
  createBuildFreshnessCheck,
  fetchDeployedBuildId,
  isBuildStale,
  markBuildStale,
  parseBuildId,
  resetBuildFreshness,
  shouldReloadOnNavigation,
  subscribeBuildStale,
  VERSION_PATH,
} from "../src/lib/buildFreshness.ts";
import { registerNavigationGuard } from "../src/lib/navigationGuard.ts";

function versionResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

afterEach(() => resetBuildFreshness());

describe("parseBuildId", () => {
  it("accepts a short build id", () => {
    assert.equal(parseBuildId({ buildId: "m4x9k2" }), "m4x9k2");
  });

  it("rejects anything that is not a bounded id", () => {
    for (const body of [null, "m4x9k2", {}, { buildId: "" }, { buildId: 7 }, { buildId: "x".repeat(129) }, { buildId: "a b" }]) {
      assert.equal(parseBuildId(body), null, JSON.stringify(body));
    }
  });
});

describe("fetchDeployedBuildId", () => {
  it("asks for the version file past every cache", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const id = await fetchDeployedBuildId(async (url, init) => {
      calls.push({ url: String(url), init });
      return versionResponse({ buildId: "next" });
    });

    assert.equal(id, "next");
    assert.equal(calls[0].url, VERSION_PATH);
    assert.equal(calls[0].init?.cache, "no-store");
  });

  it("reads a failed or malformed answer as unknown", async () => {
    assert.equal(await fetchDeployedBuildId(async () => versionResponse({ buildId: "next" }, 404)), null);
    assert.equal(await fetchDeployedBuildId(async () => new Response("<html>", { status: 200 })), null);
    assert.equal(await fetchDeployedBuildId(async () => { throw new TypeError("offline"); }), null);
  });
});

describe("createBuildFreshnessCheck", () => {
  it("marks the build stale when a different build is deployed", async () => {
    let notified = 0;
    subscribeBuildStale(() => { notified += 1; });
    const check = createBuildFreshnessCheck({ buildId: "old", fetchImpl: async () => versionResponse({ buildId: "new" }), now: () => 0 });

    assert.equal(await check(), true);
    assert.equal(isBuildStale(), true);
    assert.equal(notified, 1);
  });

  it("stays fresh when the deployed build is this one or unknown", async () => {
    const same = createBuildFreshnessCheck({ buildId: "old", fetchImpl: async () => versionResponse({ buildId: "old" }), now: () => 0 });
    assert.equal(await same(), false);
    const unknown = createBuildFreshnessCheck({ buildId: "old", fetchImpl: async () => versionResponse({}, 503), now: () => 0 });
    assert.equal(await unknown(), false);
    assert.equal(isBuildStale(), false);
  });

  it("never checks a build that carries no id (dev, tests)", async () => {
    let fetches = 0;
    const check = createBuildFreshnessCheck({ buildId: "", fetchImpl: async () => { fetches += 1; return versionResponse({ buildId: "new" }); }, now: () => 0 });

    assert.equal(await check(), false);
    assert.equal(fetches, 0);
  });

  it("asks at most once per throttle window, and not at all once stale", async () => {
    let fetches = 0;
    let clock = 0;
    let deployed = "old";
    const check = createBuildFreshnessCheck({
      buildId: "old",
      fetchImpl: async () => { fetches += 1; return versionResponse({ buildId: deployed }); },
      now: () => clock,
    });

    await check();
    clock = BUILD_CHECK_THROTTLE_MS - 1;
    await check();
    assert.equal(fetches, 1);

    deployed = "new";
    clock = BUILD_CHECK_THROTTLE_MS;
    assert.equal(await check(), true);
    clock = BUILD_CHECK_THROTTLE_MS * 3;
    assert.equal(await check(), true);
    assert.equal(fetches, 2);
  });
});

describe("shouldReloadOnNavigation", () => {
  it("is off while the running build is current", () => {
    assert.equal(shouldReloadOnNavigation("/tasks", "/threads", false), false);
  });

  it("turns a push to another page into a full load once stale", () => {
    markBuildStale();
    assert.equal(shouldReloadOnNavigation("/tasks?status=open", "/threads", false), true);
  });

  it("keeps same-page changes, replacements, and unsaved work in place", () => {
    markBuildStale();
    assert.equal(shouldReloadOnNavigation("/threads?q=deploy", "/threads", false), false);
    assert.equal(shouldReloadOnNavigation("/tasks", "/threads", true), false);
    const release = registerNavigationGuard(async () => true);
    try {
      assert.equal(shouldReloadOnNavigation("/tasks", "/threads", false), false);
    } finally {
      release();
    }
  });
});
