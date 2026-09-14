import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { describe, it } from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The dimension scales: status dots, control heights, glyph sizes, avatars.
 *
 * Colour, spacing, radii, type, and motion were all tokenised and all guarded.
 * These four were not, and each one drifted in the same way and for the same
 * reason — a raw px literal is not greppable as a deviation, so nothing could
 * report the spread and nobody could see it from inside one file:
 *
 *   dots      6, 7, 8, 9, 10, 12 across 24 declarations. thread.css drew a
 *             6px folder dot directly above a 7px thread dot in one rail.
 *   controls  24, 25, 26, 28, 32, 34, 36, 38, 48 against a documented ladder
 *             of three. `.backlog-view-btn` was 28px on one route and 34px on
 *             another — one class, two heights.
 *   glyphs    eleven values across 183 call sites, including 24 uses of 13px
 *             and 12 of 15px, each a pixel off a neighbouring rung.
 *   avatars   24, 28, 32, 36, 40, 56, tangled with the glyph sizes because
 *             both were spelled `size={N}`.
 *
 * Each suite below fails on a raw literal reappearing, which is the property
 * that actually keeps a scale honest — not the current values, which any of
 * these scales may legitimately revise.
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
const palette = readFileSync(path.join(repoRoot, MARKER), "utf8");

const stripComments = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, "");
const stripTsComments = (text: string) =>
  text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

function walk(dir: string, match: RegExp): Array<{ rel: string; text: string }> {
  const out: Array<{ rel: string; text: string }> = [];
  const step = (d: string) => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) step(full);
      else if (match.test(entry.name)) out.push({ rel: path.relative(dir, full), text: readFileSync(full, "utf8") });
    }
  };
  step(dir);
  return out;
}

/** Surface sheets — everything but the token layer, which declares the values. */
const surfaceSheets = walk(stylesDir, /\.css$/).filter((s) => !s.rel.startsWith("tokens"));
const sources = walk(srcDir, /\.tsx?$/);

const token = (name: string): number => {
  const px = palette.match(new RegExp(`${name}:\\s*(\\d+)px;`))?.[1];
  assert.ok(px, `${name} is not declared in palette.css`);
  return Number(px);
};

/** Rule blocks in a sheet, as (selector, body) with comments removed. */
function* rules(text: string): Generator<{ selector: string; body: string }> {
  for (const m of stripComments(text).matchAll(/([^{}]*?)\{([^{}]*)\}/g)) {
    const raw = m[1].trim();
    if (!raw) continue;
    yield { selector: raw.split("\n").pop()!.trim(), body: m[2] };
  }
}

describe("status dot scale", () => {
  it("declares three rungs in ascending order", () => {
    const [sm, base, lg] = [token("--dot-sm"), token("--dot"), token("--dot-lg")];
    assert.ok(sm < base && base < lg, `--dot-* is out of order: ${sm}, ${base}, ${lg}`);
  });

  it("keeps --dot-lg large enough to survive its own surface ring", () => {
    // The presence pip is ringed by 2px of the surface colour on every side to
    // punch itself out of the artwork underneath, which costs 4px of its box.
    // What is left has to still read as the in-chip tier, or the pip is a
    // smaller dot than the ones it is supposed to outrank.
    assert.ok(
      token("--dot-lg") - 4 >= token("--dot-sm"),
      "--dot-lg minus its 2px ring must still reach the --dot-sm tier",
    );
  });

  it("sizes every round dot from the scale", () => {
    const offenders: string[] = [];
    for (const sheet of surfaceSheets) {
      for (const { selector, body } of rules(sheet.text)) {
        if (!/border-radius:\s*var\(--r-full\)/.test(body)) continue;
        // A radio's dot and a checkbox's tick are round, but they are sized by
        // the CONTROL they belong to, not by the status vocabulary.
        if (/-(?:check|radio|box)(?![\w-])/.test(selector)) continue;
        const w = body.match(/\n\s*width:\s*(\d+)px/);
        const h = body.match(/\n\s*height:\s*(\d+)px/);
        // Square, round, and small enough to be a dot rather than an avatar,
        // a mark, or a vendor glyph — those size themselves.
        if (w && h && w[1] === h[1] && Number(w[1]) <= token("--dot-lg") + 2) {
          offenders.push(`${sheet.rel}: ${selector} is ${w[1]}px`);
        }
      }
    }
    assert.deepEqual(
      offenders,
      [],
      `these dots use a raw size instead of --dot-sm/--dot/--dot-lg:\n  ${offenders.join("\n  ")}`,
    );
  });
});

describe("control height ladder", () => {
  const LADDER = ["--control-h-2xs", "--control-h-xs", "--control-h-sm", "--control-h", "--control-h-lg"];

  it("runs in ascending order with no duplicate rungs", () => {
    const heights = LADDER.map(token);
    assert.deepEqual(heights, [...heights].sort((a, b) => a - b), `out of order: ${heights.join(", ")}`);
    assert.equal(new Set(heights).size, heights.length, `duplicate rungs: ${heights.join(", ")}`);
  });

  it("keeps the touch target reachable from the ladder", () => {
    // --control-h has to clear the floor on its own, or the "no coarse-pointer
    // entry needed" claim on the token is false.
    const touch = readFileSync(path.join(stylesDir, "tokens", "base.css"), "utf8")
      .match(/--touch-target:\s*(\d+)px;/)?.[1];
    assert.ok(touch, "--touch-target is not declared");
    assert.ok(token("--control-h") >= Number(touch), "--control-h must reach --touch-target");
  });

  it("sizes interactive chrome from the ladder, not a raw literal", () => {
    // Rows, headers, avatars, and marks legitimately size themselves — this
    // targets things whose selector says they are a CONTROL.
    const control = /(?:^|[\s.#\[])(?:[a-z-]*-)?(?:btn|button|toggle|chip|tab|trigger|remove|copy|close|menu-item)(?![\w-])/;
    const offenders: string[] = [];
    for (const sheet of surfaceSheets) {
      for (const { selector, body } of rules(sheet.text)) {
        if (!control.test(selector)) continue;
        // `.sidenav-btn.active::after` is a 2px activation marker drawn on a
        // button — its height is the marker's, not the control's.
        if (/::(?:before|after)/.test(selector)) continue;
        const h = body.match(/\n\s*(?:min-)?height:\s*(\d+)px/);
        if (h) offenders.push(`${sheet.rel}: ${selector} is ${h[1]}px`);
      }
    }
    assert.deepEqual(
      offenders,
      [],
      `these controls use a raw height instead of a --control-h-* rung:\n  ${offenders.join("\n  ")}`,
    );
  });

  it("keeps the button primitive's size tiers on the ladder", () => {
    const button = sources.find((s) => s.rel.endsWith(path.join("ui", "button.tsx")));
    assert.ok(button, "ui/button.tsx not found");
    const raw = stripTsComments(button.text).match(/"(?:h|size)-\d+(?:\.\d+)?[\s"]/);
    assert.equal(raw, null, `button.tsx sizes a tier with a raw Tailwind step: ${raw?.[0]}`);
  });
});

describe("glyph and avatar scales", () => {
  const icons = sources.find((s) => s.rel.endsWith(path.join("components", "icons.tsx")));
  assert.ok(icons, "components/icons.tsx not found");

  const scale = (name: string): Record<string, number> => {
    const block = icons.text.match(new RegExp(`export const ${name} = \\{([^}]*)\\}`))?.[1];
    assert.ok(block, `${name} is not exported from icons.tsx`);
    return Object.fromEntries(
      [...block.matchAll(/(\w+):\s*(\d+)/g)].map((m) => [m[1], Number(m[2])]),
    );
  };

  it("declares both scales in ascending order", () => {
    for (const name of ["ICON", "AVATAR"]) {
      const values = Object.values(scale(name));
      assert.ok(values.length >= 4, `${name} has too few rungs to be a scale`);
      assert.deepEqual(values, [...values].sort((a, b) => a - b), `${name} is out of order`);
    }
  });

  it("keeps the smallest avatar at or above the largest chrome glyph", () => {
    // An avatar is a container for a glyph. If the scales overlap the wrong
    // way, a "small avatar" ends up narrower than the icon it is meant to
    // hold — which is how 28px avatars and 24px glyphs got tangled up in one
    // `size={N}` vocabulary in the first place.
    assert.ok(scale("AVATAR").sm >= scale("ICON").xl, "AVATAR.sm must hold an ICON.xl glyph");
  });

  it("passes no raw pixel size to a glyph or avatar", () => {
    const offenders: string[] = [];
    for (const src of sources) {
      if (src.rel.endsWith(path.join("components", "icons.tsx"))) continue;
      for (const m of stripTsComments(src.text).matchAll(/\b(size|iconSize|width|height)=\{(\d+)\}/g)) {
        offenders.push(`${src.rel}: ${m[0]}`);
      }
    }
    assert.deepEqual(
      offenders,
      [],
      `pass ICON.* or AVATAR.* instead of a raw size:\n  ${offenders.join("\n  ")}`,
    );
  });
});

describe("avatar scale", () => {
  const RUNGS = ["--avatar-xs", "--avatar-sm", "--avatar-md", "--avatar-lg", "--avatar-xl", "--avatar-2xl", "--avatar-3xl"];

  it("runs in ascending order", () => {
    const values = RUNGS.map(token);
    assert.deepEqual(values, [...values].sort((a, b) => a - b), `out of order: ${values.join(", ")}`);
  });

  it("agrees with the TypeScript AVATAR scale", () => {
    // Two languages, one taxonomy. EmployeeAvatar takes its box size as a
    // prop while every other avatar takes it from CSS, so the scale has to
    // exist twice; it must not exist twice with different values.
    const icons = readFileSync(path.join(srcDir, "components", "icons.tsx"), "utf8");
    const block = icons.match(/export const AVATAR = \{([^}]*)\}/)?.[1];
    assert.ok(block, "AVATAR is not exported from icons.tsx");
    for (const [name, value] of [...block.matchAll(/(\w+):\s*(\d+)/g)].map((m) => [m[1], Number(m[2])] as const)) {
      assert.equal(token(`--avatar-${name}`), value, `AVATAR.${name} and --avatar-${name} disagree`);
    }
  });

  it("sizes every avatar box from the scale", () => {
    const avatar = /avatar(?![\w-])/;
    const offenders: string[] = [];
    for (const sheet of surfaceSheets) {
      for (const { selector, body } of rules(sheet.text)) {
        if (!avatar.test(selector)) continue;
        // The glyph INSIDE an avatar is sized by its box, not from this scale.
        if (/\bsvg\b|::(?:before|after)/.test(selector)) continue;
        const w = body.match(/\n\s*width:\s*(\d+)px/);
        const h = body.match(/\n\s*height:\s*(\d+)px/);
        if (w && h && w[1] === h[1]) offenders.push(`${sheet.rel}: ${selector} is ${w[1]}px`);
      }
    }
    assert.deepEqual(
      offenders,
      [],
      `these avatars use a raw size instead of --avatar-*:\n  ${offenders.join("\n  ")}`,
    );
  });
});

describe("CSS glyph scale", () => {
  it("mirrors the TypeScript ICON scale exactly", () => {
    // A lucide glyph takes its size as a React prop; a vendor mark drawn by a
    // stylesheet takes it from a token. Two layers, one ladder — otherwise
    // the same picture renders at two sizes depending on who drew it.
    const icons = readFileSync(path.join(srcDir, "components", "icons.tsx"), "utf8");
    const block = icons.match(/export const ICON = \{([^}]*)\}/)?.[1];
    assert.ok(block, "ICON is not exported from icons.tsx");
    for (const [name, value] of [...block.matchAll(/(\w+):\s*(\d+)/g)].map((m) => [m[1], Number(m[2])] as const)) {
      assert.equal(token(`--icon-${name}`), value, `ICON.${name} and --icon-${name} disagree`);
    }
  });

  it("sizes CSS-drawn marks from the scale", () => {
    const offenders: string[] = [];
    for (const sheet of surfaceSheets) {
      for (const { selector, body } of rules(sheet.text)) {
        if (!/-mark(?![\w-])/.test(selector)) continue;
        if (/::(?:before|after)/.test(selector)) continue;
        const w = body.match(/\n\s*width:\s*(\d+)px/);
        const h = body.match(/\n\s*height:\s*(\d+)px/);
        if (w && h && w[1] === h[1]) offenders.push(`${sheet.rel}: ${selector} is ${w[1]}px`);
      }
    }
    assert.deepEqual(
      offenders,
      [],
      `these marks use a raw size instead of --icon-* or --avatar-*:\n  ${offenders.join("\n  ")}`,
    );
  });
});

describe("weight ladder", () => {
  it("is three rungs and no sheet steps off it", () => {
    const roles = readFileSync(path.join(stylesDir, "tokens", "roles.css"), "utf8");
    const weights = new Set(
      [...stripComments(roles).matchAll(/--type-[a-z-]+:\s*(\d{3})\s/g)].map((m) => m[1]),
    );
    assert.deepEqual([...weights].sort(), ["400", "500", "700"]);

    const offenders: string[] = [];
    for (const sheet of surfaceSheets) {
      for (const m of stripComments(sheet.text).matchAll(/font-weight:\s*(\d{3})\s*;/g)) {
        if (!weights.has(m[1])) offenders.push(`${sheet.rel}: font-weight: ${m[1]}`);
      }
    }
    assert.deepEqual(offenders, [], `off-ladder weights:\n  ${offenders.join("\n  ")}`);
  });

  it("maps every Tailwind weight utility onto a rung the system owns", () => {
    // Deleting a step does not remove the utility, it hands the name back to
    // Tailwind's default — the trap the radius and text blocks in this file
    // already document. `font-semibold` reached 600 that way and shipped.
    const bridge = readFileSync(path.join(stylesDir, "tokens", "shadcn-bridge.css"), "utf8");
    const named = ["thin", "extralight", "light", "normal", "medium", "semibold", "bold", "extrabold", "black"];
    for (const name of named) {
      const value = bridge.match(new RegExp(`--font-weight-${name}:\\s*(\\d{3});`))?.[1];
      assert.ok(value, `--font-weight-${name} is unmapped, so it falls back to Tailwind's default`);
      assert.ok(["400", "500", "700"].includes(value), `--font-weight-${name} resolves to ${value}`);
    }
  });

  it("keeps the utility layer on the same weight as the role at that size", () => {
    // The app has TWO type systems: the --type-* roles in CSS, and the Tailwind
    // utilities the shadcn primitives are built from. Auditing only the first
    // one reports a weight distribution the UI does not actually have — the
    // Button alone renders on 231 call sites and never appears in a stylesheet.
    //
    // The caption and control registers (--text-micro -> --fs-1,
    // --text-xs -> --fs-2) are 500 on the CSS side: --type-micro and
    // --type-label. A primitive that sets font-bold at those sizes puts the
    // same visual register on screen at two different weights depending on
    // which layer styled it, which reads as inconsistency rather than emphasis.
    // 700 stays available above them — card.tsx pairs it with text-lg, the
    // --type-heading rung, which is exactly right.
    const offenders: string[] = [];
    for (const { rel, text } of sources.filter((f) => f.rel.endsWith(".tsx"))) {
      for (const m of text.matchAll(/\btext-(micro|xs)\b[^\n]*/g)) {
        if (/\bfont-(semibold|bold|extrabold|black)\b/.test(m[0])) {
          offenders.push(`${rel}: text-${m[1]} with a bold utility`);
        }
      }
    }
    assert.deepEqual(
      offenders,
      [],
      `these render the 12-13px register heavier than --type-micro/--type-label do:\n  ${offenders.join("\n  ")}`,
    );
  });
});

describe("tabular figures keep the root's stylistic sets", () => {
  it("never replaces --font-features with a bare tnum", () => {
    // font-feature-settings REPLACES the inherited declaration rather than
    // adding to it, so `font-feature-settings: "tnum" 1` switches OFF the
    // ss01/ss02 pair :root turns on — a pair base.css documents as
    // inseparable. The complete recipe must survive whichever Noto face is
    // active for the document language.
    const offenders: string[] = [];
    for (const sheet of walk(stylesDir, /\.css$/)) {
      for (const m of stripComments(sheet.text).matchAll(/font-feature-settings:\s*([^;]+);/g)) {
        const value = m[1].trim();
        if (value === "var(--font-features)") continue;
        if (!value.startsWith("var(--font-features)")) {
          offenders.push(`${sheet.rel}: font-feature-settings: ${value}`);
        }
      }
    }
    assert.deepEqual(
      offenders,
      [],
      `these drop the root's stylistic sets; lead with var(--font-features):\n  ${offenders.join("\n  ")}`,
    );
  });
});
