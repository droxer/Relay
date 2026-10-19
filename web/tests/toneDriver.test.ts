import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { describe, it } from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The `.tone-*` contract.
 *
 * base.css declares six tone classes and each one does exactly one thing: set
 * the `--tone` custom property. A consumer opts in by reading `var(--tone)`.
 * That indirection is the whole point — it means the tone -> hue mapping is
 * written down once, so `bad` cannot be --err in one sheet and something else
 * in another.
 *
 * Both halves of the contract had drifted, which is why this file exists:
 *
 *   VOCABULARY — TS emitted ten tone names against a driver that knew five.
 *   `live` and `muted` set no variable at all, so consumers reading
 *   `var(--tone, …)` silently took a fallback (a `.tone-live` badge halo
 *   ringed in the accent ACTION; a `.tone-live` hollow dot in the critical
 *   red). The dashboard hid its own instance of the hole by painting --live
 *   directly on its selectors.
 *
 *   CONTRACT — eight sheets re-derived the mapping for themselves with rules
 *   like `.thing.tone-good { color: var(--ok) }`, and admin-v2-views.css went
 *   further and painted `color` for six tone names under a bare, unscoped
 *   selector. That leaked by source order, which forced two more rules whose
 *   only job was to shove other components back to their own ink.
 *
 * These tests fail on either regression.
 */

const STYLES_DIR = path.join("web", "src", "styles");
const MARKER = path.join(STYLES_DIR, "tokens", "palette.css");

function findRepoRoot(): string {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (;;) {
    if (existsSync(path.join(dir, MARKER))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) throw new Error(`unable to locate ${MARKER}`);
    dir = parent;
  }
}

const repoRoot = findRepoRoot();
const stylesDir = path.join(repoRoot, STYLES_DIR);
const srcDir = path.join(repoRoot, "web", "src");

/** Every stylesheet, including the token sheets. */
function sheets(): Array<{ rel: string; text: string }> {
  const out: Array<{ rel: string; text: string }> = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(".css")) {
        out.push({ rel: path.relative(stylesDir, full), text: readFileSync(full, "utf8") });
      }
    }
  };
  walk(stylesDir);
  return out;
}

/** Every TS/TSX source file. */
function sources(): Array<{ rel: string; text: string }> {
  const out: Array<{ rel: string; text: string }> = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.tsx?$/.test(entry.name)) {
        out.push({ rel: path.relative(srcDir, full), text: readFileSync(full, "utf8") });
      }
    }
  };
  walk(srcDir);
  return out;
}

const stripComments = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, "");

const allSheets = sheets();
const base = allSheets.find((s) => s.rel === path.join("tokens", "base.css"));
assert.ok(base, "tokens/base.css not found");
const baseCode = stripComments(base.text);

/** The tone names the driver actually declares. */
const DECLARED = [...baseCode.matchAll(/\.tone-([a-z]+)\s*\{\s*--tone:/g)].map((m) => m[1]).sort();

describe("tone driver vocabulary", () => {
  it("declares exactly the six status tones, each setting only --tone", () => {
    assert.deepEqual(DECLARED, ["bad", "good", "info", "live", "neutral", "warn"]);
    for (const tone of DECLARED) {
      const rule = baseCode.match(new RegExp(`\\.tone-${tone}\\s*\\{([^}]*)\\}`));
      assert.ok(rule, `.tone-${tone} rule not found`);
      const declarations = rule[1].split(";").map((d) => d.trim()).filter(Boolean);
      assert.equal(
        declarations.length,
        1,
        `.tone-${tone} must set --tone and nothing else, got: ${declarations.join("; ")}`,
      );
      assert.match(declarations[0], /^--tone:/);
    }
  });

  it("only base.css defines a .tone-* class", () => {
    // A `.tone-x { … }` rule anywhere else is a second definition of the
    // vocabulary. Compound selectors (`.thing.tone-bad`) are a consumer
    // opting into a tone, not a definition, so they are allowed here and
    // constrained by the next suite instead.
    for (const sheet of allSheets) {
      if (sheet.rel === path.join("tokens", "base.css")) continue;
      const bare = [...stripComments(sheet.text).matchAll(/(^|[\s,>+~])\.tone-([a-z]+)\s*\{/g)];
      assert.equal(
        bare.length,
        0,
        `${sheet.rel} defines ${bare.map((m) => `.tone-${m[2]}`).join(", ")} — only tokens/base.css may`,
      );
    }
  });

  it("emits no tone name the driver does not declare", () => {
    // Catches the original bug from the other side: `tone-live` and
    // `tone-muted` were emitted from TS for months against a five-name driver.
    const emitted = new Set<string>();
    for (const src of sources()) {
      // Comments are stripped first: this file's own prose names the retired
      // tones, and so do the notes left at the sites that used to emit them.
      const code = src.text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
      // `(?<!-)` skips CSS custom properties whose NAME merely starts with
      // "tone-" — `--tone-line` is the derived hairline in roles.css, not a
      // tone class, and a component reading it (Badge's `state` variant) is
      // consuming the driver, not emitting a sixth tone.
      for (const m of code.matchAll(/(?<!-)\btone-([a-z]+)\b/g)) emitted.add(m[1]);
    }
    const unknown = [...emitted].filter((t) => !DECLARED.includes(t)).sort();
    assert.deepEqual(unknown, [], `these tone names have no --tone declaration: ${unknown.join(", ")}`);
  });

  it("keeps trend direction out of the tone vocabulary", () => {
    // up/down/flat are a DIRECTION, not a status hue, and the two sheets that
    // styled them disagreed about whether a direction even carries one:
    // artifact.css read up/down as good/bad, admin-v2-dashboard.css read them
    // as plain ink tiers. Same class names, two meanings.
    for (const name of ["up", "down", "flat", "muted"]) {
      assert.ok(
        !DECLARED.includes(name),
        `.tone-${name} is not a status tone — use a data attribute or a real tone`,
      );
    }
  });
});

describe("tone driver consumption", () => {
  // The palette hues a tone maps to. A consumer naming one of these in the
  // same rule as a .tone-* selector is re-deriving the driver's job.
  const TONE_HUES = ["--ok", "--err", "--warn", "--info", "--live"];

  it("no sheet re-derives the tone -> hue mapping", () => {
    const offenders: string[] = [];
    for (const sheet of allSheets) {
      // base.css IS the mapping — it is the one place allowed to name a hue
      // next to a tone class.
      if (sheet.rel === path.join("tokens", "base.css")) continue;
      const code = stripComments(sheet.text);
      for (const m of code.matchAll(/([^{}]*\.tone-[a-z]+[^{}]*)\{([^}]*)\}/g)) {
        const [, selector, body] = m;
        const hue = TONE_HUES.find((h) => body.includes(`var(${h})`));
        if (!hue) continue;
        // Two carve-outs, both about a tone needing MORE than its hue:
        //  - .adm-dash-bar-seg.tone-warn double-encodes warn as a repeating
        //    gradient (texture), because five states must separate in an 8px
        //    bar and hue alone cannot do it.
        //  - a rule that pairs the hue with the --t-pulse cadence is the
        //    liveness contract palette.css legislates, not a colour mapping.
        if (/repeating-linear-gradient/.test(body)) continue;
        if (/--t-pulse/.test(body)) continue;
        offenders.push(`${sheet.rel}: ${selector.trim().split("\n").pop()} uses var(${hue})`);
      }
    }
    assert.deepEqual(
      offenders,
      [],
      `these rules re-derive a tone's hue instead of reading var(--tone):\n  ${offenders.join("\n  ")}`,
    );
  });

  it("has no broad .tone-* colour painter", () => {
    // The `:where(.admin-console) .tone-* { color: … }` block. Being a bare
    // class name it leaked out of its scope by source order, and beating it
    // back cost two more rules plus a :has() carve-out.
    for (const sheet of allSheets) {
      const code = stripComments(sheet.text);
      const painter = code.match(/[^{}]*\s\.tone-[a-z]+\s*\{\s*color:[^}]*\}/);
      assert.equal(
        painter,
        null,
        `${sheet.rel} paints colour on a descendant .tone-* selector: ${painter?.[0].slice(0, 80)}`,
      );
    }
  });
});
