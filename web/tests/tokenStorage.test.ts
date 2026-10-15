import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";

import { readTokens, sanitizeTokenMap, writeTokens } from "../src/lib/appStorage.js";

const TOKEN_KEY = "relay-web.tokens";

describe("sanitizeTokenMap", () => {
  it("keeps a well-formed map as is", () => {
    assert.deepEqual(sanitizeTokenMap({ sbx_a: "tok-a", sbx_b: "tok-b" }), { sbx_a: "tok-a", sbx_b: "tok-b" });
  });

  it("drops entries whose token is not a string", () => {
    assert.deepEqual(
      sanitizeTokenMap({ good: "tok", number: 42, nested: { token: "x" }, nil: null, list: ["tok"], flag: true }),
      { good: "tok" },
    );
  });

  it("reads anything that is not a plain object as empty", () => {
    for (const value of [null, undefined, "tok", 7, true, ["tok"], [["sbx", "tok"]], new Date(0)]) {
      assert.deepEqual(sanitizeTokenMap(value), {}, `expected ${String(value)} to read as empty`);
    }
  });

  it("does not let a __proto__ key reach the prototype", () => {
    const parsed: unknown = JSON.parse('{"__proto__": {"polluted": "yes"}, "sbx": "tok"}');
    const tokens = sanitizeTokenMap(parsed);
    assert.deepEqual(Object.keys(tokens), ["sbx"]);
    assert.equal(({} as Record<string, unknown>).polluted, undefined);
  });
});

describe("readTokens", () => {
  const storage = new Map<string, string>();

  beforeEach(() => {
    storage.clear();
    (globalThis as { window?: Window }).window = {} as Window;
    globalThis.localStorage = {
      getItem: (key) => storage.get(key) ?? null,
      setItem: (key, value) => { storage.set(key, value); },
      removeItem: (key) => { storage.delete(key); },
      clear: () => { storage.clear(); },
      key: () => null,
      length: 0,
    } as Storage;
  });

  afterEach(() => {
    delete (globalThis as { window?: Window }).window;
    delete (globalThis as { localStorage?: Storage }).localStorage;
  });

  it("round-trips tokens through localStorage so they survive a reload", () => {
    writeTokens({ sbx_alice: "ui-token" });
    assert.equal(storage.get(TOKEN_KEY), JSON.stringify({ sbx_alice: "ui-token" }));
    assert.deepEqual(readTokens(), { sbx_alice: "ui-token" });
  });

  it("returns an empty map when nothing is stored", () => {
    assert.deepEqual(readTokens(), {});
  });

  it("drops malformed entries from a stored map", () => {
    storage.set(TOKEN_KEY, JSON.stringify({ sbx_alice: "ui-token", sbx_bob: 12, sbx_carol: { token: "x" } }));
    assert.deepEqual(readTokens(), { sbx_alice: "ui-token" });
  });

  it("reads a stored array, string, or null as empty", () => {
    for (const raw of ['["ui-token"]', '"ui-token"', "null", "3"]) {
      storage.set(TOKEN_KEY, raw);
      assert.deepEqual(readTokens(), {}, raw);
    }
  });

  it("reads unparseable JSON as empty", () => {
    storage.set(TOKEN_KEY, "{not json");
    assert.deepEqual(readTokens(), {});
  });

  it("returns an empty map outside the browser", () => {
    delete (globalThis as { window?: Window }).window;
    storage.set(TOKEN_KEY, JSON.stringify({ sbx_alice: "ui-token" }));
    assert.deepEqual(readTokens(), {});
  });
});
