import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { runInNewContext } from "node:vm";

import { getMe } from "../src/api-client/auth.js";
import { EARLY_AUTH_PROBE_MAX_AGE_MS, earlyAuthProbeScript, takeEarlyAuthProbe } from "../src/lib/earlyAuthProbe.js";

const HINT_KEY = "relay-web.signedIn";
const URL = "https://api.example.com/api/v1/auth/me";

type FetchCall = { url: string; init: RequestInit };

/** Runs the bootstrap statement the way the HTML does, in a page-like global. */
function runBootstrap(hint: string | null): { page: Record<string, unknown>; calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  const page: Record<string, unknown> = {
    localStorage: { getItem: (key: string) => (key === HINT_KEY ? hint : null) },
    fetch: (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return Promise.resolve(new Response("{}"));
    },
    Date,
  };
  page.window = page;
  runInNewContext(earlyAuthProbeScript(URL, HINT_KEY), page);
  return { page, calls };
}

const globals = globalThis as { window?: unknown; fetch: typeof fetch };
const realFetch = globals.fetch;

afterEach(() => {
  delete globals.window;
  globals.fetch = realFetch;
});

describe("early auth probe", () => {
  it("starts a plain credentialed GET only for a visitor signed in last time", () => {
    const signedIn = runBootstrap("1");
    assert.equal(signedIn.calls.length, 1);
    assert.equal(signedIn.calls[0].url, URL);
    assert.deepEqual({ ...signedIn.calls[0].init }, { credentials: "include" });

    for (const hint of [null, "0"]) {
      const { page, calls } = runBootstrap(hint);
      assert.equal(calls.length, 0);
      assert.equal(page.__relayEarlyAuthProbe, undefined);
    }
  });

  it("hands the response to one consumer and only while it is fresh", () => {
    const { page } = runBootstrap("1");
    globals.window = page;
    const probe = page.__relayEarlyAuthProbe as { startedAt: number };

    assert.ok(takeEarlyAuthProbe(probe.startedAt + 10));
    assert.equal(takeEarlyAuthProbe(probe.startedAt + 10), undefined);

    const stale = runBootstrap("1").page;
    globals.window = stale;
    const startedAt = (stale.__relayEarlyAuthProbe as { startedAt: number }).startedAt;
    assert.equal(takeEarlyAuthProbe(startedAt + EARLY_AUTH_PROBE_MAX_AGE_MS + 1), undefined);
    assert.equal(stale.__relayEarlyAuthProbe, undefined);
  });

  it("lets getMe reuse the early response instead of asking again", async () => {
    const body = { authenticated: true, user: { id: "u1" }, capabilities: { automationTriggers: true } };
    globals.window = {
      __relayEarlyAuthProbe: { startedAt: Date.now(), response: Promise.resolve(Response.json(body)) },
    };
    let fetched = 0;
    globals.fetch = (async () => {
      fetched += 1;
      return Response.json({ authenticated: false });
    }) as typeof fetch;

    assert.deepEqual(await getMe(), body);
    assert.equal(fetched, 0);
    // The probe is spent: the next caller asks the server.
    assert.deepEqual(await getMe(), { authenticated: false });
    assert.equal(fetched, 1);
  });

  it("surfaces an early 401 the way a direct probe would", async () => {
    globals.window = {
      __relayEarlyAuthProbe: {
        startedAt: Date.now(),
        response: Promise.resolve(Response.json({ detail: "not signed in" }, { status: 401 })),
      },
    };
    await assert.rejects(getMe(), (error: { status?: number }) => error.status === 401);
  });
});
