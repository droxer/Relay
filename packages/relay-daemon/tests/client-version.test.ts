import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { RELAY_CLIENT_VERSION } from "../src/client-version.js";

test("client release version comes from the installed daemon package", () => {
  const manifest = JSON.parse(readFileSync("packages/relay-daemon/package.json", "utf8"));
  assert.equal(RELAY_CLIENT_VERSION, manifest.version);
  assert.match(RELAY_CLIENT_VERSION, /^\d+\.\d+\.\d+/);
});
