import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { describe, it } from "node:test";
import { resolve, join, relative, extname } from "node:path";

/**
 * The status-dot contract.
 *
 * `StateMark` is the app's status-dot primitive: an 8px circle whose SHAPE
 * carries the class of the state (solid / live / ring / dashed / muted) and
 * whose hue comes from the `.tone-*` driver. The pairing is the point —
 * "bad is a hollow ring, never a solid fill" only holds if one component
 * decides it.
 *
 * It did not hold. Eight other rules drew the same 8px tone-carrying circle,
 * each with its own tone plumbing (`--tone`, `data-tone`, `.tone-*`,
 * `.offline`, `--mark-accent`), and five of them filled `bad` solid. The
 * worst inverted the vocabulary outright: `.conversation-state-dot` used the
 * hollow ring for *settled* while the rest of the app used it for *failed*,
 * so the same shape meant opposite things on adjacent surfaces.
 *
 * These tests fail if a surface grows its own status dot again.
 */

const readWeb = (path: string) => readFileSync(resolve("web", path), "utf8");

/**
 * Status dots that are deliberately NOT StateMark, with the reason each one
 * answers a different question. Anything else drawing a tone-carrying dot at
 * the row tier belongs to the primitive.
 */
const NON_STATE_DOTS = new Set([
  // The in-chip tier (--dot-sm) with its own presence x tone matrix. Already
  // ring-for-bad; folding it in needs a size rung on StateMark first.
  ".adm-agent-dot",
  // The dashboard's in-chip stat dot, same --dot-sm tier and same reason.
  ".adm-dash-stat-dot",
  // A chart legend swatch, not a status readout — it keys a series to a hue.
  ".adm-token-dot",
  // A presence pip overlaid on an avatar, not a row-tier state mark.
  ".adm-presence",
  // A grid slot in the transcript rail sized to the avatar tile it replaces,
  // not a pip beside a label.
  ".rail-node-system",
]);

function sheets(): Array<{ rel: string; text: string }> {
  const dir = resolve("web", "src", "styles");
  const out: Array<{ rel: string; text: string }> = [];
  const walk = (d: string) => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const full = join(d, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (extname(entry.name) === ".css") out.push({ rel: relative(dir, full), text: readFileSync(full, "utf8") });
    }
  };
  walk(dir);
  return out;
}

function sources(): Array<{ rel: string; text: string }> {
  const dir = resolve("web", "src");
  const out: Array<{ rel: string; text: string }> = [];
  const walk = (d: string) => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const full = join(d, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.tsx?$/.test(entry.name)) out.push({ rel: relative(dir, full), text: readFileSync(full, "utf8") });
    }
  };
  walk(dir);
  return out;
}

describe("status dot primitive", () => {
  it("leaves the row-tier tone-carrying dot to StateMark alone", () => {
    const offenders: string[] = [];
    for (const { rel, text } of sheets()) {
      // Every top-level rule: selector + body.
      // Comments first: a rule preceded by one is still a rule.
      const bare = text.replace(/\/\*[\s\S]*?\*\//g, "");
      for (const match of bare.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
        const selector = match[1].trim().split(/\n/).pop()!.trim();
        const body = match[2];
        // The row tier only: --dot exactly. --dot-lg is the presence pip
        // overlaid on an avatar, and --dot-sm the in-chip tier; both answer a
        // different question and keep their own rules.
        if (!/border-radius:\s*var\(--r-full\)/.test(body)) continue;
        if (!/(width|height):\s*var\(--dot\)/.test(body)) continue;
        if (/::(before|after)/.test(selector)) continue;
        const base = selector.match(/\.[a-z0-9-]+/i)?.[0] ?? selector;
        if (base === ".state-mark" || NON_STATE_DOTS.has(base)) continue;
        offenders.push(`${rel}: ${selector}`);
      }
    }
    assert.deepEqual(
      offenders,
      [],
      `these rules redraw the StateMark circle instead of using it:\n${offenders.join("\n")}`,
    );
  });

  it("retires every hand-rolled status dot from markup and stylesheets", () => {
    const retired = [
      "adm-live-dot",
      "adm-placement-dot",
      "agent-placement-badge-dot",
      "collaboration-status-dot",
      "conversation-state-dot",
      "project-folder-state-dot",
      "chat-agent-state-pip",
      "workspace-status-pip",
    ];
    const survivors: string[] = [];
    for (const { rel, text } of [...sheets(), ...sources()]) {
      for (const name of retired) {
        if (text.includes(name)) survivors.push(`${rel}: ${name}`);
      }
    }
    assert.deepEqual(survivors, [], `retired status dots still referenced:\n${survivors.join("\n")}`);
  });

  it("derives the shape from the tone so `bad` can only ever be a ring", () => {
    const mark = readWeb("src/components/StateMark.tsx");
    // The tone -> shape table is the enforcement point: a caller that passes a
    // tone cannot opt out of the grammar by forgetting the shape.
    assert.match(mark, /bad:\s*"ring"/);
    assert.match(mark, /live:\s*"live"/);
    // The hue still comes from the .tone-* driver, never from a local map.
    assert.match(mark, /tone-\$\{tone\}|`tone-/);
    assert.doesNotMatch(mark, /var\(--err\)|var\(--warn\)|var\(--ok\)/);
  });

  it("reads the tone driver's variable rather than naming hues again", () => {
    const css = readWeb("src/styles/task-status.css");
    assert.match(css, /\.state-mark\[data-tone\]\s*\{[^}]*--mark-accent:\s*var\(--tone\)/s);
  });
});

describe("thread rail state pips", () => {
  const row = () => readWeb("src/components/ThreadRow.tsx");
  const thread = () => readWeb("src/styles/thread.css").replace(/\/\*[\s\S]*?\*\//g, "");

  it("keeps the live pulse inside the pip so the meta line cannot clip it", () => {
    // The shared halo rides 5px proud of the dot; the subline is overflow:
    // hidden, so in the rail it rendered as a sliced crescent beside the text.
    assert.match(thread(), /\.conversation-row\s+\.state-mark\[data-shape="live"\]::after\s*\{[^}]*content:\s*none/);
    assert.match(thread(), /\.conversation-row\s+\.state-mark\[data-shape="live"\]\s*\{[^}]*animation:\s*blink/);
  });

  it("does not repeat the needs-you pip on the group header", () => {
    assert.doesNotMatch(thread(), /\.conversation-group\[data-tone="attn"\][^{]*::before/);
  });

  it("reads a cancelled thread as settled, not failed", () => {
    // Only a failure earns the --err ring; a cancel is the user's own choice.
    assert.match(row(), /thread\.statuses\.cancelled[^}]*\}/);
    assert.doesNotMatch(row(), /tone:\s*"err",\s*text:\s*t\("thread\.statuses\.cancelled"\)/);
  });
});
