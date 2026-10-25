import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  CHUNK_RELOAD_COOLDOWN_MS,
  CHUNK_RELOAD_KEY,
  isChunkLoadError,
  reloadForChunkError,
} from "../src/lib/chunkReload.ts";

function memoryStorage(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    values,
  };
}

function chunkError(): Error {
  // The shape Turbopack's runtime throws when a chunk 404s after a deploy.
  const error = new Error("Failed to load chunk /_next/static/chunks/0abc.js from module 123");
  error.name = "ChunkLoadError";
  return error;
}

describe("isChunkLoadError", () => {
  it("recognizes Turbopack's ChunkLoadError", () => {
    assert.equal(isChunkLoadError(chunkError()), true);
  });

  it("recognizes the browsers' rejected dynamic import messages", () => {
    for (const message of [
      "Failed to fetch dynamically imported module: https://get-relay.cc/_next/static/chunks/x.js",
      "error loading dynamically imported module",
      "Importing a module script failed.",
      "Loading chunk 42 failed.",
      "Loading CSS chunk 7 failed.",
    ]) {
      assert.equal(isChunkLoadError(new Error(message)), true, message);
    }
  });

  it("leaves ordinary render errors alone", () => {
    assert.equal(isChunkLoadError(new Error("Cannot read properties of undefined")), false);
    assert.equal(isChunkLoadError("Failed to load chunk"), false);
    assert.equal(isChunkLoadError(null), false);
  });
});

describe("reloadForChunkError", () => {
  it("reloads once and records when", () => {
    const storage = memoryStorage();
    let reloads = 0;
    const reloaded = reloadForChunkError(chunkError(), { storage, reload: () => { reloads += 1; }, now: 1_000 });

    assert.equal(reloaded, true);
    assert.equal(reloads, 1);
    assert.equal(storage.values.get(CHUNK_RELOAD_KEY), "1000");
  });

  it("does not loop when the reloaded page fails the same way", () => {
    const storage = memoryStorage({ [CHUNK_RELOAD_KEY]: "1000" });
    let reloads = 0;
    const reloaded = reloadForChunkError(chunkError(), {
      storage,
      reload: () => { reloads += 1; },
      now: 1_000 + CHUNK_RELOAD_COOLDOWN_MS - 1,
    });

    assert.equal(reloaded, false);
    assert.equal(reloads, 0);
  });

  it("reloads again for a later deploy once the cooldown has passed", () => {
    const storage = memoryStorage({ [CHUNK_RELOAD_KEY]: "1000" });
    let reloads = 0;
    const reloaded = reloadForChunkError(chunkError(), {
      storage,
      reload: () => { reloads += 1; },
      now: 1_000 + CHUNK_RELOAD_COOLDOWN_MS,
    });

    assert.equal(reloaded, true);
    assert.equal(reloads, 1);
  });

  it("never reloads for a non-chunk error", () => {
    let reloads = 0;
    const reloaded = reloadForChunkError(new Error("render exploded"), {
      storage: memoryStorage(),
      reload: () => { reloads += 1; },
      now: 1_000,
    });

    assert.equal(reloaded, false);
    assert.equal(reloads, 0);
  });

  it("does not reload without storage to guard against a loop", () => {
    let reloads = 0;
    const blocked = {
      getItem: () => null,
      setItem: () => { throw new Error("QuotaExceededError"); },
    };

    assert.equal(reloadForChunkError(chunkError(), { storage: null, reload: () => { reloads += 1; }, now: 1 }), false);
    assert.equal(reloadForChunkError(chunkError(), { storage: blocked, reload: () => { reloads += 1; }, now: 1 }), false);
    assert.equal(reloads, 0);
  });
});
