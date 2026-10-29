import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, it } from "node:test";

import { runtimePip } from "../src/lib/runtimePresence.js";

const read = (path: string) => readFile(resolve("web", path), "utf8");

/**
 * The executor presence mark.
 *
 * The fleet card, the fleet row, and the computer page each drew [pip glyph]
 * for one executor on one computer, out of two implementations that had
 * already drifted: the admin sheet filled a healthy pip with `--ink-4` and
 * computer.css filled the same pip with `var(--tone)`, and computer.css reached
 * across to style a `.adm-agent-dot` child it did not own. Both bypassed
 * `StateMark`, so the filled/hollow rule was written three times in total.
 */
describe("runtime presence pip", () => {
  it("says HOLLOW for every runtime that cannot take work", () => {
    for (const variant of ["bare", "labeled"] as const) {
      for (const tone of ["good", "warn", "neutral", "bad"] as const) {
        for (const presence of ["offline", "disabled"] as const) {
          assert.equal(runtimePip(presence, tone, variant).shape, "ring", `${variant}/${tone}/${presence}`);
        }
      }
      // ...and a failed runtime rings even while its computer is live: at this
      // size a solid bright dot reads as emphasis, not as a problem.
      assert.equal(runtimePip("online", "bad", variant).shape, "ring", variant);
    }
  });

  it("says FILLED for a healthy online runtime", () => {
    for (const variant of ["bare", "labeled"] as const) {
      for (const tone of ["good", "warn", "neutral"] as const) {
        assert.equal(runtimePip("online", tone, variant).shape, "solid", `${variant}/${tone}`);
      }
    }
  });

  it("spends hue only where a reader can act on it", () => {
    // Bare: no name, no state word beside the pip, so ready and unknown both
    // take the calm ink fill — at 6px a good-green and a neutral grey are one
    // dot, and a hue there would imply a difference it never shows.
    assert.equal(runtimePip("online", "good", "bare").tone, undefined);
    assert.equal(runtimePip("online", "neutral", "bare").tone, undefined);
    assert.equal(runtimePip("online", "warn", "bare").tone, undefined);
    assert.equal(runtimePip("online", "bad", "bare").tone, "bad");

    // Labeled: the row spells out name, state and version, so the pip may
    // restate the full tone.
    assert.equal(runtimePip("online", "good", "labeled").tone, "good");
    assert.equal(runtimePip("online", "warn", "labeled").tone, "warn");

    // A dark computer is not an alarm — its runtimes ring in neutral ink
    // unless the runtime is itself unhappy.
    assert.equal(runtimePip("offline", "good", "labeled").tone, undefined);
    assert.equal(runtimePip("offline", "warn", "labeled").tone, "warn");
    assert.equal(runtimePip("offline", "bad", "bare").tone, "bad");

    // Switched off on purpose: an administrative fact, never hued.
    for (const tone of ["good", "warn", "neutral", "bad"] as const) {
      assert.equal(runtimePip("disabled", tone, "bare").tone, undefined, tone);
      assert.equal(runtimePip("disabled", tone, "labeled").tone, undefined, tone);
    }
  });
});

describe("runtime mark surfaces", () => {
  it("draws the pip with StateMark rather than a bespoke dot", async () => {
    const mark = await read("src/components/RuntimeMark.tsx");
    assert.match(mark, /<StateMark shape=\{pip\.shape\} tone=\{pip\.tone\}/);
    // No hand-rolled dot element: the pip is the primitive, not an <i>.
    assert.doesNotMatch(mark, /<i className/);
  });

  it("draws the vendor glyph only where no name sits beside it", async () => {
    const mark = await read("src/components/RuntimeMark.tsx");
    // The bare mark is a glyph alone, so it keeps it; a labeled mark sits
    // beside the runtime's name, where the glyph would say it twice.
    assert.match(mark, /variant === "labeled" \? null : <AgentMark\b/);
  });

  it("has one implementation, shared by the fleet and the computer page", async () => {
    for (const path of [
      "src/components/admin/NodeRuntimeMarks.tsx",
      "src/components/computer/ComputerCard.tsx",
    ]) {
      const source = await read(path);
      assert.match(source, /<RuntimeMark\b/, path);
      assert.doesNotMatch(source, /adm-agent-dot/, path);
    }
  });

  it("keeps computer.css out of the admin sheet's dot", async () => {
    const css = await read("src/styles/computer.css");
    assert.doesNotMatch(css, /\.adm-agent-dot/);
  });
});
