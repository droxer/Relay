import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { RELAY_CLIENT_VERSION } from "../src/client-version.js";

test("client release version comes from the installed daemon package", () => {
  const manifest = JSON.parse(readFileSync("packages/relay-daemon/package.json", "utf8"));
  assert.equal(RELAY_CLIENT_VERSION, manifest.version);
  assert.match(RELAY_CLIENT_VERSION, /^\d+\.\d+\.\d+/);
});

test("an installed package reports its own release after an upgrade", async () => {
  const { mkdtempSync, mkdirSync, copyFileSync, writeFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { pathToFileURL } = await import("node:url");
  const { execFileSync } = await import("node:child_process");
  const root = mkdtempSync(join(tmpdir(), "relay-version-"));
  try {
    mkdirSync(join(root, "dist"));
    writeFileSync(join(root, "package.json"), JSON.stringify({
      name: "relay-daemon", type: "module", version: "7.8.9-rc.1+test",
      exports: { ".": "./dist/client-version.js" },
    }));
    const entry = join(root, "dist/client-version.js");
    copyFileSync(new URL("../src/client-version.js", import.meta.url), entry);
    const output = execFileSync(process.execPath, ["--input-type=module", "-e",
      `import { RELAY_CLIENT_VERSION } from ${JSON.stringify(pathToFileURL(entry).href)}; console.log(RELAY_CLIENT_VERSION);`,
    ], { encoding: "utf8" });
    assert.equal(output.trim(), "7.8.9-rc.1+test");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
