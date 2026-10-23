import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { ansi } from "../src/format.js";

// The compiled test runs from dist/packages/relay-core/tests, so resolve the
// renderer's TypeScript source from the repository root.
const renderersSource = readFileSync(
  fileURLToPath(new URL("../../../../packages/relay-core/src/renderers.ts", import.meta.url)),
  "utf8",
);

describe("terminal palette", () => {
  it("names the web palette's three roles in 256-colour codes", () => {
    // --action baton orange, --live signal blue, --err crimson (palette.css dark register).
    assert.equal(ansi.action, "\x1b[38;5;208m");
    assert.equal(ansi.live, "\x1b[38;5;75m");
    assert.equal(ansi.err, "\x1b[38;5;204m");
  });

  it("marks every agent's turn in the live blue, never a per-runtime hue", () => {
    for (const stock of ["ansi.yellow", "ansi.magenta", "ansi.cyan", "ansi.blue", "ansi.green", "ansi.brand"]) {
      assert.ok(!renderersSource.includes(stock), `renderers.ts still paints with ${stock}`);
    }
    assert.ok(renderersSource.includes("ansi.live"));
  });
});
